#!/usr/bin/env bash
WORK="${E2E_WORK:-/tmp/handy-e2e}"
for p in shim vite; do [[ -f "$WORK/$p.pid" ]] && kill "$(cat "$WORK/$p.pid")" 2>/dev/null; done
pkill -f "vite --port 5173" 2>/dev/null || true
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
RUN_AS=(); [[ "$(id -u)" == "0" ]] && RUN_AS=(runuser -u postgres --)
"${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
echo stopped
