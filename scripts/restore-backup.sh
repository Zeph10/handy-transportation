#!/usr/bin/env bash
# Restore a nightly backup into a Supabase database (normally a NEW, empty project).
#
# Usage:
#   scripts/restore-backup.sh handy-backup-YYYYMMDD-HHMMSS.tar.gz.age ~/.age/handy-backup.key "postgresql://postgres.<ref>:<pw>@...:5432/postgres"
#
# Steps it performs (the procedure Supabase documents for CLI dumps):
#   1. decrypt with your private age key and unpack roles.sql, schema.sql, data.sql
#   2. psql: roles → schema → data (triggers disabled during the data load)
# Afterwards: redeploy Edge Functions and secrets (docs/SETUP.md), then reconnect
# Google Calendar from Admin → Integrations (the Vault secret is not portable).
set -euo pipefail
FILE="${1:?backup file}"
KEY="${2:?age private key file}"
DB_URL="${3:?target database URL}"

command -v age >/dev/null || { echo "Install age first (brew install age / apt install age)"; exit 1; }
command -v psql >/dev/null || { echo "Install the PostgreSQL client (psql) first"; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
age -d -i "$KEY" "$FILE" | tar -xzf - -C "$WORK"
echo "Backup created at: $(cat "$WORK/CREATED_AT" 2>/dev/null || echo unknown)"

read -r -p "This will load the backup into the target database. Type RESTORE to continue: " answer
[[ "$answer" == "RESTORE" ]] || { echo "Cancelled."; exit 1; }

psql --single-transaction --variable ON_ERROR_STOP=1 \
  --file "$WORK/roles.sql" \
  --file "$WORK/schema.sql" \
  --command 'SET session_replication_role = replica' \
  --file "$WORK/data.sql" \
  --dbname "$DB_URL"

echo "Restore complete. Verify counts:"
psql "$DB_URL" -X -A -t -c "select 'drivers', count(*) from public.driver_profiles union all select 'blocks', count(*) from public.availability_blocks union all select 'reservations', count(*) from public.reservations;"
