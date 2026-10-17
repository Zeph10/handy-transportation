#!/usr/bin/env bash
# Prove the database is restorable: build a database from the migrations,
# load demo data, dump it, restore the dump into an empty database (with
# triggers disabled, as the real restore does) and compare row counts.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-}"
if [[ -z "$PGBIN" ]]; then
  if command -v initdb >/dev/null 2>&1; then PGBIN="$(dirname "$(command -v initdb)")";
  else PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"; fi
fi
WORK="$(mktemp -d)"; PORT="${PGPORT_TEST:-55433}"
RUN_AS=(); if [[ "$(id -u)" == "0" ]]; then chown -R postgres "$WORK"; RUN_AS=(runuser -u postgres --); fi
cleanup() { "${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
"${RUN_AS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust --no-sync >/dev/null
"${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses='' -c fsync=off" -l "$WORK/log" -w start >/dev/null
P=("${RUN_AS[@]}" "$PGBIN/psql" -h "$WORK" -p "$PORT" -U postgres -X -q -v ON_ERROR_STOP=1)

"${P[@]}" -d postgres -c "create database src" -c "create database dst" >/dev/null
"${P[@]}" -d src -f "$ROOT/supabase/tests/auth_shim.sql" >/dev/null
for f in "$ROOT"/supabase/migrations/*.sql; do "${P[@]}" -d src -f "$f" >/dev/null; done
"${P[@]}" -d src -f "$ROOT/supabase/seed.sql" >/dev/null

counts() { "${P[@]}" -d "$1" -A -t -c "select string_agg(t || '=' || n, ' ' order by t) from (
  select 'profiles' t, count(*) n from public.driver_profiles union all
  select 'vehicles', count(*) from public.vehicles union all
  select 'rules', count(*) from public.availability_rules union all
  select 'blocks', count(*) from public.availability_blocks union all
  select 'block_dest', count(*) from public.availability_block_destinations union all
  select 'audit', count(*) from public.audit_log union all
  select 'destinations', count(*) from public.destinations) x"; }

before="$(counts src)"
"${RUN_AS[@]}" "$PGBIN/pg_dump" -h "$WORK" -p "$PORT" -U postgres --schema-only -d src -f "$WORK/schema.sql"
"${RUN_AS[@]}" "$PGBIN/pg_dump" -h "$WORK" -p "$PORT" -U postgres --data-only -d src -f "$WORK/data.sql"
"${P[@]}" -d dst -f "$WORK/schema.sql" >/dev/null
"${P[@]}" -d dst --single-transaction -c 'SET session_replication_role = replica' -f "$WORK/data.sql" >/dev/null
after="$(counts dst)"

echo "source:   $before"
echo "restored: $after"
[[ "$before" == "$after" ]] && echo "Backup/restore round trip OK" || { echo "MISMATCH"; exit 1; }
# Restored database still enforces its rules (the exclusion constraint survived).
if "${P[@]}" -d dst -c "insert into public.availability_blocks (driver_id, start_at, end_at, status) select driver_id, start_at, end_at, 'UNAVAILABLE' from public.availability_blocks limit 1" >/dev/null 2>&1; then
  echo "Constraint check FAILED after restore"; exit 1
fi
echo "Constraints intact after restore"
