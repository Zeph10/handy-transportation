-- Email notification support (called by the send-notifications Edge Function).
-- Only WEEKLY_REMINDER is enabled at launch; other categories exist but are off
-- until an admin turns them on, so no schema change is needed to add them.

-- Drivers who should get this week's optional reminder, not yet sent.
create or replace function public.notifications_weekly_candidates(p_week_key text)
returns table (user_id uuid, email text, full_name text, has_next_week boolean)
language sql stable security definer set search_path = '' as $$
  with s as (select * from public.app_settings where id = 1),
  next_week as (
    select (date_trunc('week', (now() at time zone 'America/New_York')) + interval '7 days')::date as mon
  )
  select p.user_id, p.email, p.full_name,
    exists (
      select 1 from public.availability_blocks b, next_week w
      where b.driver_id = p.user_id and b.deleted_at is null
        and b.start_at >= (w.mon::timestamp at time zone 'America/New_York')
        and b.start_at < ((w.mon + 7)::timestamp at time zone 'America/New_York')
    ) or exists (
      select 1 from public.availability_rules r, next_week w
      where r.driver_id = p.user_id and r.deleted_at is null
        and r.effective_from <= w.mon + 6 and (r.effective_until is null or r.effective_until >= w.mon)
    ) as has_next_week
  from public.driver_profiles p
  join public.notification_categories c on c.code = 'WEEKLY_REMINDER' and c.enabled_globally
  cross join s
  where s.reminder_enabled
    and p.status = 'APPROVED'
    and p.email <> ''
    and coalesce((select np.enabled from public.notification_preferences np where np.user_id = p.user_id and np.category = 'WEEKLY_REMINDER'), c.default_on)
    and not exists (select 1 from public.notification_deliveries d where d.dedupe_key = 'WEEKLY_REMINDER:' || p_week_key || ':' || p.user_id::text and d.status = 'SENT');
$$;

-- Is now (America/New_York) the configured reminder hour?
create or replace function public.notifications_reminder_due()
returns boolean language sql stable security definer set search_path = '' as $$
  select s.reminder_enabled
     and extract(isodow from (now() at time zone 'America/New_York'))::int = s.reminder_dow
     and extract(hour from (now() at time zone 'America/New_York'))::int = extract(hour from s.reminder_time)::int
  from public.app_settings s where s.id = 1;
$$;

-- Record a delivery attempt (idempotent per dedupe key).
create or replace function public.notification_record(p_user uuid, p_category text, p_key text, p_status public.delivery_status,
  p_provider_id text default null, p_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.notification_deliveries (user_id, category, dedupe_key, status, provider_message_id, attempts, error, sent_at)
  values (p_user, p_category, p_key, p_status, p_provider_id, 1, left(p_error, 1000), case when p_status = 'SENT' then now() end)
  on conflict (dedupe_key) do update set status = excluded.status, provider_message_id = coalesce(excluded.provider_message_id, public.notification_deliveries.provider_message_id),
    attempts = public.notification_deliveries.attempts + 1, error = excluded.error, sent_at = coalesce(excluded.sent_at, public.notification_deliveries.sent_at);
end $$;

-- Rate limit: how many emails went out today (Resend free tier allows 100/day).
create or replace function public.notifications_sent_today()
returns integer language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.notification_deliveries
  where status = 'SENT' and sent_at >= date_trunc('day', now() at time zone 'UTC');
$$;

revoke all on function public.notifications_weekly_candidates(text) from public, anon, authenticated;
revoke all on function public.notifications_reminder_due() from public, anon, authenticated;
revoke all on function public.notification_record(uuid, text, text, public.delivery_status, text, text) from public, anon, authenticated;
revoke all on function public.notifications_sent_today() from public, anon, authenticated;
grant execute on function public.notifications_weekly_candidates(text), public.notifications_reminder_due(),
  public.notification_record(uuid, text, text, public.delivery_status, text, text), public.notifications_sent_today() to service_role;
