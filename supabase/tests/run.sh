#!/usr/bin/env bash
# Run database tests against a throwaway local PostgreSQL cluster.
#
# - Applies supabase/tests/auth_shim.sql (stand-in for Supabase's auth schema),
#   then every migration in order, then each *.test.sql file in its own
#   transaction (rolled back afterwards, so tests never affect each other).
# - Requires PostgreSQL 15+ server binaries (initdb, pg_ctl, psql) on PATH or in
#   /usr/lib/postgresql/<ver>/bin. In CI this runs on the GitHub-hosted runner.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PGBIN="${PGBIN:-}"
if [[ -z "$PGBIN" ]]; then
  if command -v initdb >/dev/null 2>&1; then PGBIN="$(dirname "$(command -v initdb)")";
  else PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"; fi
fi
[[ -x "$PGBIN/initdb" ]] || { echo "PostgreSQL server binaries not found (set PGBIN)"; exit 1; }

WORK="$(mktemp -d)"
PORT="${PGPORT_TEST:-55432}"
RUN_AS=()
if [[ "$(id -u)" == "0" ]]; then
  chown -R postgres "$WORK"
  RUN_AS=(runuser -u postgres --)
fi

cleanup() { "${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

"${RUN_AS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust --no-sync >/dev/null
"${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses='' -c fsync=off -c timezone=UTC" -l "$WORK/log" -w start >/dev/null

PSQL=("${RUN_AS[@]}" "$PGBIN/psql" -h "$WORK" -p "$PORT" -U postgres -X -q -v ON_ERROR_STOP=1)
"${PSQL[@]}" -d postgres -c "create database handy_test" >/dev/null
PSQL+=(-d handy_test)

echo "Applying auth shim and migrations..."
"${PSQL[@]}" -f "$ROOT/supabase/tests/auth_shim.sql" >/dev/null
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "  $(basename "$f")"
  "${PSQL[@]}" -f "$f" >/dev/null
done
"${PSQL[@]}" -f "$ROOT/supabase/tests/helpers.sql" >/dev/null

pass=0; fail=0
for t in "$ROOT"/supabase/tests/*.test.sql; do
  name="$(basename "$t")"
  if out=$( { echo "begin;"; cat "$t"; echo "rollback;"; } | "${PSQL[@]}" 2>&1 ); then
    echo "ok   $name"; pass=$((pass+1))
  else
    echo "FAIL $name"; echo "$out" | sed 's/^/     /'; fail=$((fail+1))
  fi
done

if [[ "${CHECK_SEED:-1}" == "1" ]]; then
  if "${PSQL[@]}" -f "$ROOT/supabase/seed.sql" >/dev/null 2>"$WORK/seed.err"; then echo "ok   seed.sql applies cleanly"; pass=$((pass+1));
  else echo "FAIL seed.sql"; sed 's/^/     /' "$WORK/seed.err"; fail=$((fail+1)); fi
fi

echo "Database tests: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
