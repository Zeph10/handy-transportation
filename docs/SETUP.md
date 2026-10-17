# Setup guide: every account and setting you configure

This is the complete list of things only you can do (they need your logins or your domain). Follow it top to bottom once. Expect about 90 minutes. Nothing here costs money on the free tiers except the domain you already own.

Values you will collect along the way are marked like **`THIS`**. Keep them in a password manager. Never paste a secret into the web app's `.env` file, a chat, or a GitHub issue.

| Step | Service | What you get |
| --- | --- | --- |
| 1 | GitHub | The code repository and free CI/backup runs |
| 2 | Supabase | Database, logins, server functions |
| 3 | Resend | Login-link and reminder emails from support@bychuckhandy.com |
| 4 | Google Cloud | Read-only access to the reservations calendar |
| 5 | Cloudflare | Website hosting and the login-form bot check |
| 6 | Wire it together | Secrets, first admin, reminder schedule, backups |

---

## 1. GitHub

1. Create a **private** repository `handy-transportation` under your account (no README; the code already has one).
2. Push the code (or let Claude push it once the repository exists).
3. **Settings → Actions → General**: allow GitHub Actions.

CI then runs on every push: core tests, type checks, database security tests and the backup round-trip test.

## 2. Supabase (database, logins, functions)

1. Sign up at supabase.com and create an organization on the **Free** plan.
2. **New project**: name `handy-transportation`, region **East US (North Virginia)**, a strong database password → **`DB_PASSWORD`**.
3. **Project Settings → API**: copy **`SUPABASE_URL`**, the **`anon` public key** and the **`service_role` key** (secret: only for Edge Functions, never the browser).
4. **Project Settings → Database → Connection string → Session pooler**: copy the URI and insert your password → **`SUPABASE_DB_URL`** (used only by the backup job).
5. On your computer, install the Supabase CLI (`brew install supabase/tap/supabase` on Mac, or see supabase.com/docs/guides/cli), then from the project folder:

   ```bash
   supabase login
   supabase link --project-ref <your-project-ref>
   supabase db push            # applies supabase/migrations (never the demo seed)
   ```

6. Mark the database as production so demo data can never be loaded into it. In **SQL Editor** run:

   ```sql
   update public.app_settings set environment = 'production' where id = 1;
   ```

7. **Authentication → Sign In / Providers → Email**: enable Email; turn **off** "Confirm email" (the magic link itself proves the address); leave passwords unused.
8. **Authentication → URL Configuration**:
   - Site URL: `https://<your-site>` (from step 5, e.g. `https://drivers.bychuckhandy.com`)
   - Redirect URLs: `https://<your-site>/auth/callback`
9. **Authentication → Emails → Templates → Magic Link**: paste the contents of `supabase/templates/magic_link.html`; subject `Your Handy Transportation login link`.
10. **Authentication → Rate Limits**: keep defaults (they limit login emails per address and per IP).

## 3. Resend (email from support@bychuckhandy.com)

Supabase's built-in email only reaches your own team and a few messages per hour, so real drivers need custom SMTP.

1. Sign up at resend.com (Free: 3,000 emails/month, 100/day).
2. **Domains → Add domain** → `bychuckhandy.com`. Resend shows DNS records (SPF/DKIM, usually TXT and MX records on a `send` subdomain). Add them wherever bychuckhandy.com's DNS is managed (Cloudflare, GoDaddy, Google Domains/Squarespace…). Wait until Resend shows **Verified**.
   - These records do **not** affect your existing support@bychuckhandy.com mailbox; they authorize Resend to send on the domain's behalf.
3. **API Keys → Create** with "Sending access" to bychuckhandy.com → **`RESEND_API_KEY`**.
4. In Supabase **Authentication → Emails → SMTP Settings**, enable custom SMTP:
   - Host `smtp.resend.com`, port `465`, username `resend`, password = **`RESEND_API_KEY`**
   - Sender email `support@bychuckhandy.com`, sender name `Handy Transportation`
5. Test: on the live site, request a login link to your own address.

## 4. Google Cloud (read-only calendar access)

The reservations calendar is owned by `support@bychuckhandy.com`. Do these steps signed in as that account.

1. Go to console.cloud.google.com → **Create project** `Handy Transportation`.
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform):
   - **User type**: choose **Internal** if the option is offered (it is when bychuckhandy.com uses Google Workspace). Internal apps need no Google verification and show no warning.
   - If only **External** is offered: choose External, then later set **Publishing status → In production**. Do not leave it in "Testing": testing-mode refresh tokens expire after 7 days and sync would break weekly. An unverified external app shows a one-time "Google hasn't verified this app" screen to the admin at connect time; click **Advanced → Go to Handy Transportation**.
   - App name `Handy Transportation Dispatch`, support email `support@bychuckhandy.com`.
   - **Data access / Scopes**: add exactly these two, nothing broader:
     - `.../auth/calendar.events.readonly` (See events on all your calendars)
     - `.../auth/calendar.calendarlist.readonly` (See the list of Google calendars you're subscribed to)
4. **Clients → Create client → Web application**:
   - Authorized redirect URI: `https://<your-project-ref>.supabase.co/functions/v1/google-oauth-callback`
   - Copy **`GOOGLE_CLIENT_ID`** and **`GOOGLE_CLIENT_SECRET`**.

The app never asks for write access, and the code rejects a connection if Google grants broader scopes than these.

## 5. Cloudflare (website hosting and bot check)

1. Sign up at cloudflare.com (Free).
2. **Turnstile → Add widget**: domain = your site domain, mode **Managed** → **`TURNSTILE_SITE_KEY`** (public) and **`TURNSTILE_SECRET_KEY`**.
   In Supabase **Authentication → Attack Protection**: enable CAPTCHA, provider Turnstile, paste the secret key.
3. **Workers & Pages → Create → Pages → Connect to Git** → choose the GitHub repo:
   - Build command: `npm ci && npm --workspace apps/web run build`
   - Build output directory: `apps/web/dist`
   - Environment variables (Production): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_TURNSTILE_SITE_KEY`, and `NODE_VERSION` = `22`
4. **Custom domains**: add e.g. `drivers.bychuckhandy.com` and follow the DNS prompt.
5. Go back to Supabase step 2.8 and Google step 4 if the final site URL changed.

## 6. Wire it together

### Edge Function secrets and deploy

Create `supabase/.env` (git-ignored) from the second section of `.env.example`, filling in `APP_URL` (your site), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `RESEND_API_KEY`, `EMAIL_FROM` and a new `CRON_SECRET` (`openssl rand -hex 32`). Then:

```bash
supabase secrets set --env-file supabase/.env
supabase functions deploy google-oauth-start
supabase functions deploy google-oauth-callback --no-verify-jwt
supabase functions deploy google-calendars
supabase functions deploy calendar-sync
supabase functions deploy send-notifications --no-verify-jwt
```

### First administrator

1. Open the live site, enter your email, and click the login link (this creates your account as a pending driver).
2. In Supabase **SQL Editor** run, with your email:

   ```sql
   select public.bootstrap_admin('you@example.com');
   ```

3. Reload the site: you now see the admin screens. Approve drivers from **Admin → Approvals** from here on.

### Weekly reminder schedule

In **Database → Extensions** enable `pg_cron` and `pg_net`. Then in **SQL Editor** (replace the two values):

```sql
select vault.create_secret('<CRON_SECRET>', 'cron_secret');
select vault.create_secret('https://<your-project-ref>.supabase.co', 'project_url');

select cron.schedule('weekly-reminder-check', '5 * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/send-notifications',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb);
$$);
```

The job runs hourly but only sends during the reminder day and hour set in **Admin → Settings** (default Wednesday 10 AM), once per driver per week.

### Google Calendar

**Admin → Integrations → Connect Google Calendar**, sign in as `support@bychuckhandy.com`, allow read-only access, pick the reservations calendar, then press **Sync now**.

### Nightly backups

1. Install `age` on your computer and create a key pair once: `age-keygen -o ~/.age/handy-backup.key`. Store that file somewhere safe and offline (it is the only way to read backups). The command prints the public key (`age1…`).
2. GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**:
   - `SUPABASE_DB_URL` = **`SUPABASE_DB_URL`**
   - `BACKUP_AGE_PUBLIC_KEY` = the `age1…` public key
3. **Actions → Nightly database backup → Run workflow** to test it now. Restore steps are in `docs/BACKUP_AND_RESTORE.md`.

---

## Upgrading to Supabase Pro ($25/month)

Do this once real drivers depend on the app.

1. Supabase → **Organization → Billing → Change plan → Pro**. No migration or downtime; the same project upgrades in place.
2. You gain: no pausing after 7 idle days, daily backups kept 7 days (restorable from the dashboard), 8 GB database, higher limits.
3. Keep the GitHub backup job running anyway: it is an independent, off-site copy.
