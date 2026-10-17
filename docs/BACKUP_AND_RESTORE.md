# Backup and restore

**On the Supabase Free plan there are no automatic database backups.** This project makes its own: a GitHub Actions job dumps the production database every night, encrypts the dump with your public `age` key, and stores it as a private workflow artifact for 30 days. Only someone holding your private key file can read it.

On Supabase Pro you additionally get daily dashboard backups (7 days). Keep the nightly job either way; it is the off-site copy.

## What a backup contains

| File (inside the encrypted archive) | Contents |
| --- | --- |
| `roles.sql` | Database roles |
| `schema.sql` | Tables, functions, security policies |
| `data.sql` | All rows: drivers, logins, vehicles, availability, reservations, corrections, settings, audit log |
| `CREATED_AT` | When the backup was taken (UTC) |

Not included: the Google refresh token (Supabase Vault secrets are encrypted with a key tied to the project), and Edge Function secrets. After a restore to a new project you reconnect Google Calendar once and set the function secrets again.

## Checking backups are running

GitHub → your repository → **Actions → Nightly database backup**. Each green run has an artifact named `handy-backup-YYYYMMDD-HHMMSS.tar.gz.age`. A red run emails the repository owner automatically.

## Restoring

Use a **new, empty Supabase project** so the damaged one stays available for comparison.

1. Create the new project (docs/SETUP.md step 2.1–2.4). Do **not** run `supabase db push`; the backup contains the schema.
2. Download the artifact from GitHub Actions and unzip the outer `.zip` GitHub adds.
3. Run, from the project folder:

   ```bash
   scripts/restore-backup.sh handy-backup-YYYYMMDD-HHMMSS.tar.gz.age ~/.age/handy-backup.key "<new project's SUPABASE_DB_URL>"
   ```

   Type `RESTORE` when asked. It prints driver, availability and reservation counts at the end.
4. Point the website at the new project (Cloudflare Pages environment variables → redeploy), set the Edge Function secrets and deploy the functions (SETUP.md step 6), and update the Supabase URL in the Google OAuth redirect URI.
5. **Admin → Integrations → Reconnect Google Calendar**, then **Sync now**.

## Exporting a copy from the app

**Admin → Exports → Full data export (JSON)** downloads every table you can see as an admin. It is useful for spreadsheets and records, but the encrypted nightly dump is the restorable backup.

## How the procedure is verified

`scripts/test-backup-restore.sh` runs in CI on every push: it builds a database from the migrations, loads sample data, dumps it, restores it into an empty database with triggers disabled (as the real restore does), compares row counts table by table, and checks that the overlap constraint still rejects contradictory availability after the restore.
