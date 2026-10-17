# Handy Transportation — driver availability & dispatch assistance

Drivers share when they can work (vehicle, destinations, minimum rates). The dispatcher sees everyone's availability on one calendar, overlays the company's Google Calendar reservations (read-only), and gets a ranked list of drivers who fit each unfilled trip, with every reason a driver does not fit. It assists dispatch; it never assigns trips, contacts drivers or writes to Google Calendar.

| Part | Technology | Where it runs | Cost |
| --- | --- | --- | --- |
| Website | React, TypeScript, Vite, Tailwind, FullCalendar | Cloudflare Pages | $0 |
| Database, logins, security | Supabase Postgres + Auth, Row Level Security | Supabase | $0 (Pro $25/mo recommended later) |
| Server functions | Supabase Edge Functions (Deno, no npm dependencies) | Supabase | $0 |
| Email | Resend via custom SMTP | Resend | $0 |
| Reservations | Google Calendar API, read-only OAuth | Google | $0 |
| Shared logic | `core/` (dependency-free TypeScript) | Browser and Edge Functions | — |

## Repository layout

```
core/                     Scheduling, recurrence, DST, matching, parsing, money (zero dependencies) + tests
apps/web/                 React app (driver and admin screens)
supabase/migrations/      Database schema, Row Level Security, server functions, reference data
supabase/functions/       Edge Functions: Google OAuth, calendar sync, reminders
supabase/tests/           Database tests (run on a throwaway local Postgres)
supabase/seed.sql         Development demo data (never applied to production)
scripts/                  Core copy for functions, backup restore, backup round-trip test
docs/                     Setup, admin guide, driver guide, backup/restore, costs
.github/workflows/        CI and nightly encrypted backup
```

## Run the tests

Requires Node 22+ and PostgreSQL 15+ server binaries (`initdb`, `pg_ctl`).

```bash
node --test core/test/*.test.ts apps/web/test/*.test.ts   # 77 unit tests
bash supabase/tests/run.sh                                # migrations + RLS/RPC/sync/notification tests
bash scripts/test-backup-restore.sh                       # dump → restore → compare
```

## Local development

```bash
npm install
supabase start                      # local Supabase in Docker (applies migrations + demo seed)
cp .env.example apps/web/.env.local # fill VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY from `supabase status`
npm run dev                         # http://localhost:5173
```

Demo logins (local only): `admin@demo.handy.test`, `dana@demo.handy.test`, `eli@demo.handy.test`, `pending@demo.handy.test`. Request a link on the login page, then open it from the local inbox at http://localhost:54324.

After editing anything in `core/`, run `node scripts/sync-core.mjs` so the Edge Functions get the same code (CI checks this).

## Documentation

- [docs/SETUP.md](docs/SETUP.md): every account, OAuth setting, secret and deployment step you configure
- [docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md): day-to-day use for the dispatcher
- [docs/DRIVER_GUIDE.md](docs/DRIVER_GUIDE.md): one-page guide to send to drivers
- [docs/BACKUP_AND_RESTORE.md](docs/BACKUP_AND_RESTORE.md)
- [docs/COSTS.md](docs/COSTS.md): free tier vs paid tier
- [docs/DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md): how scheduling, security and matching work

## Key rules the code enforces

- Unsubmitted time is UNKNOWN, never available. Time off and admin "mark unavailable" override everything; date-specific blocks override the weekly schedule only where they overlap.
- Wall-clock recurrence in America/New_York with explicit DST rules (tested on both 2026 transitions).
- A driver is eligible only if confirmed availability covers pickup − travel allowance through pickup + trip duration + buffer. Tentative coverage is "Tentative", missing facts are "Review required", overrides are "Overridden"; none of these is ever shown as eligible.
- Driver minimums are compared with the base payout; the NYC congestion surcharge is always a separate line.
- Drivers never write tables directly; every change goes through a database function that checks identity, validates, enforces the short-notice approval window and writes the audit log.
