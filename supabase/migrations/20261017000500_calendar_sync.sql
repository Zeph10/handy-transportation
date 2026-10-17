-- Google Calendar connection and synchronization.
-- Called by Edge Functions with the service-role key; never by browsers,
-- except admin_set_calendar / admin_disconnect_calendar / admin_sync_status.
--
-- Supabase Vault (enabled by default on Supabase projects) stores the refresh
-- token encrypted. Only these service-role functions can read it.

-- Store (or replace) the single calendar connection after OAuth succeeds.
create or replace function public.store_calendar_connection(p_admin uuid, p_account_email text, p_scopes text[], p_refresh_token text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_conn public.calendar_connections;
  v_secret uuid;
begin
  if not exists (select 1 from public.user_roles where user_id = p_admin and role = 'ADMIN') then
    perform public.app_error('FORBIDDEN', 'Only an administrator can connect Google Calendar.');
  end if;
  if p_refresh_token is null or char_length(p_refresh_token) < 10 then
    perform public.app_error('VALIDATION', 'Google did not return a refresh token. Remove the app''s access in your Google account and connect again.');
  end if;
  select * into v_conn from public.calendar_connections order by created_at limit 1 for update;
  if found and v_conn.vault_secret_id is not null then
    perform vault.update_secret(v_conn.vault_secret_id, p_refresh_token);
    v_secret := v_conn.vault_secret_id;
  else
    v_secret := vault.create_secret(p_refresh_token, 'google_calendar_refresh_token_' || gen_random_uuid()::text,
      'Google Calendar read-only refresh token for Handy Transportation');
  end if;
  if found then
    -- Reconnecting keeps the same connection row, so imported reservations and corrections survive.
    update public.calendar_connections set google_account_email = p_account_email, scopes = p_scopes, vault_secret_id = v_secret,
      status = 'CONNECTED', last_error = null, connected_by = p_admin, connected_at = now()
    where id = v_conn.id;
    return v_conn.id;
  end if;
  insert into public.calendar_connections (google_account_email, scopes, vault_secret_id, status, connected_by, connected_at)
  values (p_account_email, p_scopes, v_secret, 'CONNECTED', p_admin, now()) returning id into v_conn.id;
  return v_conn.id;
end $$;

-- Admin chooses which calendar to read.
create or replace function public.admin_set_calendar(p_calendar_id text, p_calendar_name text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_admin uuid := public._require_admin();
begin
  if char_length(btrim(coalesce(p_calendar_id, ''))) = 0 then perform public.app_error('VALIDATION', 'Choose a calendar.'); end if;
  update public.calendar_connections set calendar_id = btrim(p_calendar_id), calendar_name = left(p_calendar_name, 200)
   where status <> 'DISCONNECTED';
  if not found then perform public.app_error('NOT_FOUND', 'Connect Google Calendar first.'); end if;
end $$;

-- Disconnect: forget the token, keep every imported reservation and correction.
create or replace function public.admin_disconnect_calendar()
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_admin uuid := public._require_admin();
  v_conn public.calendar_connections;
begin
  select * into v_conn from public.calendar_connections where status <> 'DISCONNECTED' for update;
  if not found then return; end if;
  if v_conn.vault_secret_id is not null then
    delete from vault.secrets where id = v_conn.vault_secret_id;
  end if;
  update public.calendar_connections set status = 'DISCONNECTED', vault_secret_id = null where id = v_conn.id;
end $$;

-- Begin a sync run. Fails with SYNC_RUNNING if another run is in progress.
create or replace function public.sync_begin(p_started_by uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_conn public.calendar_connections;
  v_run uuid;
  s public.app_settings;
  v_start timestamptz;
  v_end timestamptz;
begin
  if not exists (select 1 from public.user_roles where user_id = p_started_by and role = 'ADMIN') then
    perform public.app_error('FORBIDDEN', 'Administrator access required.');
  end if;
  select * into s from public.app_settings where id = 1;
  select * into v_conn from public.calendar_connections where status <> 'DISCONNECTED';
  if not found then perform public.app_error('NOT_FOUND', 'Google Calendar is not connected.'); end if;
  if v_conn.calendar_id is null then perform public.app_error('VALIDATION', 'Choose which calendar to read first.'); end if;
  -- Runs stuck for more than 10 minutes are marked failed so a new one can start.
  update public.sync_runs set status = 'FAILED', finished_at = now(), error = 'Timed out'
   where status = 'RUNNING' and started_at < now() - interval '10 minutes';
  v_start := date_trunc('day', now()) - make_interval(days => s.sync_window_past_days);
  v_end := date_trunc('day', now()) + make_interval(days => s.sync_window_future_days);
  begin
    insert into public.sync_runs (connection_id, started_by, window_start, window_end)
    values (v_conn.id, p_started_by, v_start, v_end) returning id into v_run;
  exception when unique_violation then
    perform public.app_error('SYNC_RUNNING', 'A sync is already running. Try again in a minute.');
  end;
  return jsonb_build_object('run_id', v_run, 'connection_id', v_conn.id, 'calendar_id', v_conn.calendar_id,
    'window_start', v_start, 'window_end', v_end);
end $$;

create or replace function public.sync_get_refresh_token(p_connection uuid)
returns text language sql stable security definer set search_path = '' as $$
  select d.decrypted_secret
  from public.calendar_connections c join vault.decrypted_secrets d on d.id = c.vault_secret_id
  where c.id = p_connection;
$$;

-- Everything the parser needs, from the database (so admins can change it without a deploy).
create or replace function public.sync_parser_config()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'markers', coalesce((select jsonb_agg(jsonb_build_object('source', source, 'pattern', pattern)) from public.reservation_markers where enabled), '[]'::jsonb),
    'rules', coalesce((select jsonb_agg(jsonb_build_object('field', field, 'source', source, 'pattern', pattern, 'priority', priority, 'enabled', enabled))
                       from public.parsing_rules), '[]'::jsonb),
    'rates', coalesce((select jsonb_agg(jsonb_build_object('pattern', pattern, 'destinationCode', destination_code, 'congestion', congestion, 'priority', priority))
                       from public.rate_mappings), '[]'::jsonb),
    'drivers', coalesce((select jsonb_agg(jsonb_build_object('driverId', p.user_id, 'fullName', p.full_name, 'email', p.email,
                         'aliases', coalesce((select jsonb_agg(a.alias) from public.driver_aliases a where a.driver_id = p.user_id), '[]'::jsonb)))
                       from public.driver_profiles p where p.status in ('APPROVED', 'SUSPENDED')), '[]'::jsonb));
$$;

-- Apply one sync's events. p_rows: array of reservation rows built by core/src/sync.ts.
-- Idempotent: upserts on (connection_id, google_event_id); unchanged rows are not rewritten.
create or replace function public.sync_apply(p_run uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run public.sync_runs;
  r jsonb;
  v_existing public.reservations;
  v_ins integer := 0;
  v_upd integer := 0;
  v_same integer := 0;
  v_removed integer := 0;
  v_vanished integer := 0;
  v_seen text[] := '{}';
begin
  select * into v_run from public.sync_runs where id = p_run for update;
  if not found or v_run.status <> 'RUNNING' then perform public.app_error('NOT_FOUND', 'Sync run is not active.'); end if;
  if jsonb_typeof(p_rows) <> 'array' then perform public.app_error('VALIDATION', 'Rows must be an array.'); end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_seen := v_seen || (r->>'google_event_id');
    select * into v_existing from public.reservations where connection_id = v_run.connection_id and google_event_id = r->>'google_event_id';
    if not found then
      if (r->>'source_status') = 'cancelled' then v_same := v_same + 1; continue; end if; -- never seen and already cancelled
      insert into public.reservations (connection_id, google_event_id, ical_uid, recurring_event_id, original_start, etag, google_updated_at,
        source_status, removed_from_source, raw_summary, raw_description, raw_location, attendee_emails, start_at, end_at, all_day, parsed,
        parser_version, is_reservation, trip_ref, destination_code, passengers, checked_bags, assignment, assigned_driver_id, congestion,
        payout_cents, review_flags, last_synced_at)
      values (v_run.connection_id, r->>'google_event_id', r->>'ical_uid', r->>'recurring_event_id', (r->>'original_start')::timestamptz,
        r->>'etag', (r->>'google_updated_at')::timestamptz, r->>'source_status', false, r->>'raw_summary', r->>'raw_description',
        r->>'raw_location', coalesce(array(select jsonb_array_elements_text(r->'attendee_emails')), '{}'), (r->>'start_at')::timestamptz,
        (r->>'end_at')::timestamptz, coalesce((r->>'all_day')::boolean, false), coalesce(r->'parsed', '{}'::jsonb),
        coalesce((r->>'parser_version')::integer, 0), coalesce((r->>'is_reservation')::boolean, false), r->>'trip_ref', r->>'destination_code',
        (r->>'passengers')::integer, (r->>'checked_bags')::integer, coalesce(r->>'assignment', 'NOT_A_RESERVATION')::public.assignment_state,
        (select user_id from public.driver_profiles where user_id = nullif(r->>'assigned_driver_id', '')::uuid),
        coalesce(r->>'congestion', 'UNKNOWN')::public.congestion_state, (r->>'payout_cents')::integer,
        coalesce(array(select jsonb_array_elements_text(r->'review_flags')), '{}'), now());
      v_ins := v_ins + 1;
    elsif (r->>'source_status') = 'cancelled' then
      if not v_existing.removed_from_source then
        update public.reservations set removed_from_source = true, source_status = 'cancelled', etag = r->>'etag',
          google_updated_at = (r->>'google_updated_at')::timestamptz, last_synced_at = now()
        where id = v_existing.id;
        v_removed := v_removed + 1;
      else
        update public.reservations set last_synced_at = now() where id = v_existing.id;
        v_same := v_same + 1;
      end if;
    elsif v_existing.etag is not distinct from r->>'etag'
          and v_existing.parser_version = coalesce((r->>'parser_version')::integer, 0)
          and v_existing.parsed = coalesce(r->'parsed', '{}'::jsonb)
          and not v_existing.removed_from_source then
      update public.reservations set last_synced_at = now() where id = v_existing.id;
      v_same := v_same + 1;
    else
      update public.reservations set ical_uid = r->>'ical_uid', recurring_event_id = r->>'recurring_event_id',
        original_start = (r->>'original_start')::timestamptz, etag = r->>'etag', google_updated_at = (r->>'google_updated_at')::timestamptz,
        source_status = r->>'source_status', removed_from_source = false, raw_summary = r->>'raw_summary', raw_description = r->>'raw_description',
        raw_location = r->>'raw_location', attendee_emails = coalesce(array(select jsonb_array_elements_text(r->'attendee_emails')), '{}'),
        start_at = (r->>'start_at')::timestamptz, end_at = (r->>'end_at')::timestamptz, all_day = coalesce((r->>'all_day')::boolean, false),
        parsed = coalesce(r->'parsed', '{}'::jsonb), parser_version = coalesce((r->>'parser_version')::integer, 0),
        is_reservation = coalesce((r->>'is_reservation')::boolean, false), trip_ref = r->>'trip_ref', destination_code = r->>'destination_code',
        passengers = (r->>'passengers')::integer, checked_bags = (r->>'checked_bags')::integer,
        assignment = coalesce(r->>'assignment', 'NOT_A_RESERVATION')::public.assignment_state,
        assigned_driver_id = (select user_id from public.driver_profiles where user_id = nullif(r->>'assigned_driver_id', '')::uuid),
        congestion = coalesce(r->>'congestion', 'UNKNOWN')::public.congestion_state, payout_cents = (r->>'payout_cents')::integer,
        review_flags = coalesce(array(select jsonb_array_elements_text(r->'review_flags')), '{}'), last_synced_at = now()
      where id = v_existing.id;
      v_upd := v_upd + 1;
    end if;
  end loop;

  -- Events that vanished from the window (hard-deleted in Google) are marked removed, never deleted.
  update public.reservations set removed_from_source = true, last_synced_at = now()
   where connection_id = v_run.connection_id and not removed_from_source
     and start_at >= v_run.window_start and start_at < v_run.window_end
     and not (google_event_id = any(v_seen));
  get diagnostics v_vanished = row_count;
  v_removed := v_removed + v_vanished;

  update public.sync_runs set events_seen = jsonb_array_length(p_rows), inserted = v_ins, updated = v_upd,
    unchanged = v_same, removed = v_removed
  where id = p_run;
  return jsonb_build_object('inserted', v_ins, 'updated', v_upd, 'unchanged', v_same, 'removed', v_removed);
end $$;

create or replace function public.sync_finish(p_run uuid, p_ok boolean, p_error text default null, p_auth_expired boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare v_run public.sync_runs;
begin
  select * into v_run from public.sync_runs where id = p_run for update;
  if not found then return; end if;
  update public.sync_runs set status = case when p_ok then 'SUCCEEDED' else 'FAILED' end::public.sync_status,
    finished_at = now(), error = case when p_ok then null else left(p_error, 1000) end
  where id = p_run;
  update public.calendar_connections set
    last_success_at = case when p_ok then now() else last_success_at end,
    last_error = case when p_ok then null else left(p_error, 1000) end,
    status = case when p_auth_expired then 'EXPIRED' when p_ok then 'CONNECTED' else status end
  where id = v_run.connection_id;
end $$;

-- Status banner data for the admin UI: last success, staleness, last error.
create or replace function public.admin_sync_status()
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when not public.is_admin() then null else jsonb_build_object(
    'connection', (select jsonb_build_object('status', c.status, 'account', c.google_account_email, 'calendar_id', c.calendar_id,
                     'calendar_name', c.calendar_name, 'last_success_at', c.last_success_at, 'last_error', c.last_error)
                   from public.calendar_connections c order by c.created_at limit 1),
    'last_run', (select to_jsonb(r) - 'connection_id' from public.sync_runs r order by r.started_at desc limit 1),
    'stale', coalesce((select c.last_success_at is null or c.last_success_at < now() - make_interval(hours => s.stale_after_hours)
                       or c.status <> 'CONNECTED'
                       from public.calendar_connections c, public.app_settings s order by c.created_at limit 1), true),
    'running', exists (select 1 from public.sync_runs where status = 'RUNNING' and started_at > now() - interval '10 minutes'))
  end;
$$;

-- Reservations with local corrections applied; each field says where its value came from.
create or replace view public.reservations_effective with (security_invoker = true) as
select
  r.id, r.google_event_id, r.trip_ref, r.start_at as pickup_at, r.end_at as event_end_at, r.all_day, r.source_status,
  r.removed_from_source, r.last_synced_at, r.review_flags, r.parsed, r.raw_summary, r.raw_description, r.raw_location,
  coalesce(c.is_reservation, r.is_reservation) as is_reservation,
  coalesce(c.destination_id, d.id) as destination_id,
  coalesce(cd.code, r.destination_code) as destination_code,
  case when c.destination_id is not null then 'CORRECTED' when r.destination_code is not null then 'CALENDAR' else 'UNKNOWN' end as destination_source,
  coalesce(c.passenger_count, r.passengers) as passengers,
  case when c.passenger_count is not null then 'CORRECTED' when r.passengers is not null then 'CALENDAR' else 'UNKNOWN' end as passengers_source,
  coalesce(c.checked_bags, r.checked_bags) as checked_bags,
  case
    when c.clear_assignment then 'UNFILLED'::public.assignment_state
    when c.assigned_driver_id is not null then 'ASSIGNED'::public.assignment_state
    else r.assignment end as assignment,
  case when c.clear_assignment then null else coalesce(c.assigned_driver_id, r.assigned_driver_id) end as assigned_driver_id,
  case when c.clear_assignment or c.assigned_driver_id is not null then 'CORRECTED' else 'CALENDAR' end as assignment_source,
  c.proposed_payout_cents as corrected_payout_cents,
  r.payout_cents as calendar_payout_cents,
  coalesce(c.congestion, r.congestion) as congestion,
  case when c.congestion is not null then 'CORRECTED' when r.congestion <> 'UNKNOWN' then 'CALENDAR' else 'UNKNOWN' end as congestion_source,
  c.duration_minutes as corrected_duration_minutes,
  c.notes as correction_notes,
  c.version as correction_version
from public.reservations r
left join public.reservation_corrections c on c.reservation_id = r.id
left join public.destinations d on d.code = r.destination_code
left join public.destinations cd on cd.id = c.destination_id;

grant select on public.reservations_effective to authenticated;

revoke all on function public.store_calendar_connection(uuid, text, text[], text) from public, anon, authenticated;
revoke all on function public.sync_begin(uuid) from public, anon, authenticated;
revoke all on function public.sync_get_refresh_token(uuid) from public, anon, authenticated;
revoke all on function public.sync_parser_config() from public, anon, authenticated;
revoke all on function public.sync_apply(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.sync_finish(uuid, boolean, text, boolean) from public, anon, authenticated;
grant execute on function public.store_calendar_connection(uuid, text, text[], text), public.sync_begin(uuid),
  public.sync_get_refresh_token(uuid), public.sync_parser_config(), public.sync_apply(uuid, jsonb),
  public.sync_finish(uuid, boolean, text, boolean) to service_role;

revoke all on function public.admin_set_calendar(text, text) from public, anon;
revoke all on function public.admin_disconnect_calendar() from public, anon;
revoke all on function public.admin_sync_status() from public, anon;
grant execute on function public.admin_set_calendar(text, text), public.admin_disconnect_calendar(), public.admin_sync_status() to authenticated;
