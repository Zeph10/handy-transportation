# Running costs

**Today: $0/month.** The only fixed cost is the bychuckhandy.com domain you already pay for. The recommended upgrade once drivers rely on the app is **Supabase Pro at $25/month**.

Prices checked October 2026; vendors change them, so recheck before upgrading.

| Service | Free tier (what matters here) | Expected use | Cost now | Upgrade |
| --- | --- | --- | --- | --- |
| Cloudflare Pages | Static hosting, generous build allowance | One static website | $0 | Not needed |
| Supabase | 500 MB database, 50,000 monthly active users, 500,000 function calls; **pauses after 7 days with no activity; no automatic backups** | Well under 50 MB for years of availability; a few thousand function calls a month | $0 | **Pro $25/mo**: never pauses, daily backups (7 days), 8 GB |
| Resend | 3,000 emails/month, 100/day, 1 domain | Login links + one weekly reminder per driver | $0 | Pro $20/mo if you exceed 100 emails a day |
| Google Calendar API | Free at this volume | One sync = a few requests | $0 | Not needed |
| GitHub Actions | Free minutes for private repos (2,000/month) | CI + nightly backup, a few minutes a day | $0 | Not needed |
| Cloudflare Turnstile | Free | Login form | $0 | Not needed |
| Routing / maps | None used | Trip durations are admin-set estimates | $0 | Optional later (e.g. OpenRouteService free key) |

## The free-tier risks, plainly

1. **Pausing.** A free Supabase project with no database activity for 7 days is paused. Restoring it is one click in the Supabase dashboard and loses no data, but the site is down until then. Weekly driver logins and the hourly reminder check normally keep it active; a holiday lull could still trigger it. Pro removes pausing.
2. **Backups.** The free plan has none. The nightly GitHub backup covers this (docs/BACKUP_AND_RESTORE.md). Pro adds Supabase's own daily backups.
3. **Email cap.** 100 emails per day covers magic links and weekly reminders for roughly 80 drivers. The reminder job stops at 90 per day and continues in later runs. Resend Pro removes the cap.

## When to upgrade

Move to Supabase Pro ($25/month) when either is true: drivers depend on the site every week, or a day of downtime from a pause would cost you a trip. Steps: docs/SETUP.md → "Upgrading to Supabase Pro".
