#!/usr/bin/env bash
# TEST-ONLY: throwaway Postgres (real migrations + demo seed) + Supabase protocol shim + Vite dev server.
# Usage: bash e2e/start-stack.sh   (prints URLs; stop with bash e2e/stop-stack.sh)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
WORK="${E2E_WORK:-/tmp/handy-e2e}"
bash "$ROOT/e2e/stop-stack.sh" >/dev/null 2>&1 || true
PORT=55440
rm -rf "$WORK"; mkdir -p "$WORK"
RUN_AS=(); if [[ "$(id -u)" == "0" ]]; then chown -R postgres "$WORK"; RUN_AS=(runuser -u postgres --); fi
"${RUN_AS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust --no-sync >/dev/null
"${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=127.0.0.1 -c fsync=off" -l "$WORK/pg.log" -w start >/dev/null
P=("${RUN_AS[@]}" "$PGBIN/psql" -h 127.0.0.1 -p $PORT -U postgres -X -q -v ON_ERROR_STOP=1)
"${P[@]}" -d postgres -c "create database handy" >/dev/null
"${P[@]}" -d handy -f "$ROOT/supabase/tests/auth_shim.sql" >/dev/null
for f in "$ROOT"/supabase/migrations/*.sql; do "${P[@]}" -d handy -f "$f" >/dev/null; done
"${P[@]}" -d handy -f "$ROOT/supabase/seed.sql" >/dev/null
DATABASE_URL="postgresql://postgres@127.0.0.1:$PORT/handy" nohup node "$ROOT/e2e/supabase-shim/server.mjs" > "$WORK/shim.log" 2>&1 &
echo $! > "$WORK/shim.pid"
cd "$ROOT/apps/web"
VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_ANON_KEY=test-anon-key nohup npx vite --port 5173 --strictPort --host 127.0.0.1 > "$WORK/vite.log" 2>&1 &
echo $! > "$WORK/vite.pid"
for i in $(seq 1 40); do curl -s -o /dev/null http://127.0.0.1:5173 && curl -s -o /dev/null http://127.0.0.1:54321/rest/v1/destinations && break; sleep 0.5; done
echo "DB:   postgresql://postgres@127.0.0.1:$PORT/handy"
echo "API:  http://127.0.0.1:54321 (test shim)"
echo "App:  http://127.0.0.1:5173"
