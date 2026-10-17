-- Server-side functions (RPCs). Every driver mutation lives here.
--
-- Error contract: functions raise SQLSTATE P0001 with message "<CODE>: <text>".
-- Codes: AUTH, FORBIDDEN, NOT_FOUND, VALIDATION, OVERLAP, CONFLICT (stale version), STALE.
-- The web app shows <text> to the user and uses <CODE> for behaviour.

-- ---------------------------------------------------------------------------
-- Internal helpers (not executable by clients)
-- ---------------------------------------------------------------------------
create or replace function public._require_user()
returns uuid language plpgsql stable set search_path = '' as $$
declare v uuid := auth.uid();
begin
  if v is null then perform public.app_error('AUTH', 'Please sign in.'); end if;
  return v;
end $$;

create or replace function public._require_approved_driver()
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare v uuid := public._require_user();
begin
  if not exists (select 1 from public.driver_profiles where user_id = v and status = 'APPROVED') then
    perform public.app_error('FORBIDDEN', 'Your account is not approved yet.');
  end if;
  return v;
end $$;

create or replace function public._require_admin()
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare v uuid := public._require_user();
begin
  if not exists (select 1 from public.user_roles where user_id = v and role = 'ADMIN') then
    perform public.app_error('FORBIDDEN', 'Administrator access required.');
  end if;
  return v;
end $$;

create or replace function public._settings()
returns public.app_settings language sql stable security definer set search_path = '' as $$
  select * from public.app_settings where id = 1;
$$;

-- Redact anything that looks like a credential before it reaches the audit log.
create or replace function public._redact(p jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select case when p is null then null else (
    select coalesce(jsonb_object_agg(k, case when k ~* '(token|secret|password|vault|code_verifier)' then '"[redacted]"'::jsonb else v end), '{}'::jsonb)
    from jsonb_each(p) as e(k, v)
  ) end;
$$;

create or replace function public.write_audit(
  p_action text, p_table text, p_entity_id text, p_driver uuid, p_before jsonb, p_after jsonb, p_reason text default null
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_role text;
begin
  select role::text into v_role from public.user_roles where user_id = v_actor;
  insert into public.audit_log (actor_id, actor_role, action, entity_table, entity_id, affected_driver_id, reason, before, after)
  values (v_actor, coalesce(v_role, case when v_actor is null then 'SYSTEM' else 'DRIVER' end), p_action, p_table, p_entity_id,
          p_driver, coalesce(p_reason, nullif(current_setting('app.audit_reason', true), '')),
          public._redact(p_before), public._redact(p_after));
end $$;

-- Block + its destinations as one JSON document (used for audit and change requests).
create or replace function public._block_snapshot(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', b.id, 'driver_id', b.driver_id, 'start_at', b.start_at, 'end_at', b.end_at, 'status', b.status,
    'vehicle_id', b.vehicle_id, 'notes', b.notes, 'rule_id', b.rule_id, 'occurrence_date', b.occurrence_date,
    'origin', b.origin, 'version', b.version, 'deleted_at', b.deleted_at,
    'destinations', coalesce((
      select jsonb_agg(jsonb_build_object('destination_id', d.destination_id, 'min_rate_cents', d.min_rate_cents) order by d.destination_id)
      from public.availability_block_destinations d where d.block_id = b.id), '[]'::jsonb))
  from public.availability_blocks b where b.id = p_id;
$$;

create or replace function public._rule_snapshot(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', r.id, 'driver_id', r.driver_id, 'weekdays', r.weekdays, 'local_start', to_char(r.local_start, 'HH24:MI'),
    'local_end', to_char(r.local_end, 'HH24:MI'), 'end_day_offset', r.end_day_offset, 'effective_from', r.effective_from,
    'effective_until', r.effective_until, 'status', r.status, 'vehicle_id', r.vehicle_id, 'notes', r.notes,
    'version', r.version, 'deleted_at', r.deleted_at,
    'destinations', coalesce((
      select jsonb_agg(jsonb_build_object('destination_id', d.destination_id, 'min_rate_cents', d.min_rate_cents) order by d.destination_id)
      from public.availability_rule_destinations d where d.rule_id = r.id), '[]'::jsonb))
  from public.availability_rules r where r.id = p_id;
$$;

-- Validate destinations array: [{destination_id, min_rate_cents}]
create or replace function public._validate_destinations(p jsonb, p_required boolean)
returns void language plpgsql stable security definer set search_path = '' as $$
declare
  d jsonb;
  v_rate integer;
  v_seen uuid[] := '{}';
  v_id uuid;
begin
  if p is null or jsonb_typeof(p) <> 'array' then
    if p_required then perform public.app_error('VALIDATION', 'Pick at least one destination.'); end if;
    return;
  end if;
  if p_required and jsonb_array_length(p) = 0 then perform public.app_error('VALIDATION', 'Pick at least one destination.'); end if;
  for d in select * from jsonb_array_elements(p) loop
    begin
      v_id := (d->>'destination_id')::uuid;
    exception when others then
      perform public.app_error('VALIDATION', 'A destination is invalid.');
    end;
    if v_id = any(v_seen) then perform public.app_error('VALIDATION', 'A destination is listed twice.'); end if;
    v_seen := v_seen || v_id;
    if not exists (select 1 from public.destinations where id = v_id and is_active) then
      perform public.app_error('VALIDATION', 'A destination is not available.');
    end if;
    if d ? 'min_rate_cents' and jsonb_typeof(d->'min_rate_cents') <> 'null' then
      if jsonb_typeof(d->'min_rate_cents') <> 'number' or (d->>'min_rate_cents')::numeric <> trunc((d->>'min_rate_cents')::numeric) then
        perform public.app_error('VALIDATION', 'Minimum rates must be whole cents.');
      end if;
      v_rate := (d->>'min_rate_cents')::integer;
      if v_rate < 0 or v_rate > 1000000 then perform public.app_error('VALIDATION', 'Minimum rate must be between $0 and $10,000.'); end if;
    end if;
  end loop;
end $$;

create or replace function public._validate_vehicle_ref(p_driver uuid, p_vehicle uuid, p_status public.availability_status)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if p_status = 'UNAVAILABLE' then return; end if;
  if p_vehicle is null then perform public.app_error('VALIDATION', 'Choose the vehicle you will drive.'); end if;
  if not exists (select 1 from public.vehicles where id = p_vehicle and driver_id = p_driver and is_active and deleted_at is null) then
    perform public.app_error('VALIDATION', 'That vehicle is not one of your active vehicles.');
  end if;
end $$;

create or replace function public._validate_block(p_driver uuid, p jsonb)
returns void language plpgsql stable security definer set search_path = '' as $$
declare
  v_start timestamptz;
  v_end timestamptz;
  v_status public.availability_status;
begin
  begin
    v_start := (p->>'start_at')::timestamptz;
    v_end := (p->>'end_at')::timestamptz;
    v_status := coalesce(p->>'status', 'AVAILABLE')::public.availability_status;
  exception when others then
    perform public.app_error('VALIDATION', 'Start, end or status is invalid.');
  end;
  if v_start is null or v_end is null then perform public.app_error('VALIDATION', 'Start and end are required.'); end if;
  if v_end <= v_start then perform public.app_error('VALIDATION', 'End must be after start.'); end if;
  if v_end - v_start > interval '7 days' then perform public.app_error('VALIDATION', 'A single block can be at most 7 days long.'); end if;
  if char_length(coalesce(p->>'notes', '')) > 1000 then perform public.app_error('VALIDATION', 'Notes are too long.'); end if;
  perform public._validate_vehicle_ref(p_driver, nullif(p->>'vehicle_id', '')::uuid, v_status);
  perform public._validate_destinations(p->'destinations', v_status <> 'UNAVAILABLE');
  if (p->>'rule_id') is not null then
    if not exists (select 1 from public.availability_rules where id = (p->>'rule_id')::uuid and driver_id = p_driver) then
      perform public.app_error('VALIDATION', 'That recurring schedule does not belong to you.');
    end if;
    if (p->>'occurrence_date') is null then perform public.app_error('VALIDATION', 'Occurrence date is required.'); end if;
  end if;
end $$;

-- Insert a block and its destinations (validated by caller). Returns the id.
create or replace function public._insert_block(p_driver uuid, p jsonb, p_origin public.block_origin)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  begin
    insert into public.availability_blocks (driver_id, start_at, end_at, status, vehicle_id, notes, rule_id, occurrence_date, origin, created_by)
    values (p_driver, (p->>'start_at')::timestamptz, (p->>'end_at')::timestamptz,
            coalesce(p->>'status', 'AVAILABLE')::public.availability_status,
            case when coalesce(p->>'status', 'AVAILABLE') = 'UNAVAILABLE' then null else nullif(p->>'vehicle_id', '')::uuid end,
            nullif(btrim(p->>'notes'), ''), nullif(p->>'rule_id', '')::uuid, nullif(p->>'occurrence_date', '')::date,
            p_origin, auth.uid())
    returning id into v_id;
  exception
    when exclusion_violation then
      perform public.app_error('OVERLAP', 'This time overlaps another availability block. Edit or remove that block first.');
    when unique_violation then
      perform public.app_error('OVERLAP', 'That recurring occurrence has already been changed for this date.');
  end;
  if coalesce(p->>'status', 'AVAILABLE') <> 'UNAVAILABLE' then
    insert into public.availability_block_destinations (block_id, destination_id, min_rate_cents)
    select v_id, (d->>'destination_id')::uuid, nullif(d->>'min_rate_cents', '')::integer
    from jsonb_array_elements(coalesce(p->'destinations', '[]'::jsonb)) d;
  end if;
  return v_id;
end $$;

create or replace function public._update_block(p_id uuid, p jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  begin
    update public.availability_blocks set
      start_at = (p->>'start_at')::timestamptz,
      end_at = (p->>'end_at')::timestamptz,
      status = coalesce(p->>'status', 'AVAILABLE')::public.availability_status,
      vehicle_id = case when coalesce(p->>'status', 'AVAILABLE') = 'UNAVAILABLE' then null else nullif(p->>'vehicle_id', '')::uuid end,
      notes = nullif(btrim(p->>'notes'), '')
    where id = p_id;
  exception when exclusion_violation then
    perform public.app_error('OVERLAP', 'This time overlaps another availability block. Edit or remove that block first.');
  end;
  delete from public.availability_block_destinations where block_id = p_id;
  if coalesce(p->>'status', 'AVAILABLE') <> 'UNAVAILABLE' then
    insert into public.availability_block_destinations (block_id, destination_id, min_rate_cents)
    select p_id, (d->>'destination_id')::uuid, nullif(d->>'min_rate_cents', '')::integer
    from jsonb_array_elements(coalesce(p->'destinations', '[]'::jsonb)) d;
  end if;
end $$;

-- Short-notice window: does [p_start, p_end) touch [now, now + window)?
create or replace function public._in_short_notice(p_start timestamptz, p_end timestamptz)
returns boolean language sql stable security definer set search_path = '' as $$
  select s.short_notice_window_hours > 0
     and p_start < now() + make_interval(hours => s.short_notice_window_hours)
     and p_end > now()
  from public.app_settings s where s.id = 1;
$$;

-- First local date fully outside the short-notice window (series edits take effect from here).
create or replace function public._series_cutoff_date()
returns date language sql stable security definer set search_path = '' as $$
  select ((now() + make_interval(hours => s.short_notice_window_hours)) at time zone 'America/New_York')::date
         + case when s.short_notice_window_hours > 0 then 1 else 0 end
  from public.app_settings s where s.id = 1;
$$;

create or replace function public._status_rank(s text)
returns integer language sql immutable set search_path = '' as $$
  select case s when 'AVAILABLE' then 1 when 'TENTATIVE' then 2 when 'UNAVAILABLE' then 3 else 0 end;
$$;

-- Effective minimum for a destination: block value → profile default → preset.
create or replace function public._effective_min(p_driver uuid, p_dest uuid, p_block_min integer)
returns integer language sql stable security definer set search_path = '' as $$
  select coalesce(p_block_min,
    (select min_rate_cents from public.driver_destination_defaults where driver_id = p_driver and destination_id = p_dest),
    (select preset_payout_cents from public.destinations where id = p_dest));
$$;

-- Does replacing block snapshot p_old with payload p_new reduce what the driver offers?
create or replace function public._block_change_reduces(p_driver uuid, p_old jsonb, p_new jsonb)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  o_start timestamptz := (p_old->>'start_at')::timestamptz;
  o_end timestamptz := (p_old->>'end_at')::timestamptz;
  n_start timestamptz := (p_new->>'start_at')::timestamptz;
  n_end timestamptz := (p_new->>'end_at')::timestamptz;
  o_status text := p_old->>'status';
  n_status text := coalesce(p_new->>'status', 'AVAILABLE');
  d jsonb;
  v_new_min integer;
  o_seats integer;
  n_seats integer;
begin
  if o_status = 'UNAVAILABLE' then
    -- Shrinking an unavailable block adds availability; growing it removes some.
    return n_status = 'UNAVAILABLE' and (n_start < o_start or n_end > o_end);
  end if;
  if public._status_rank(n_status) > public._status_rank(o_status) then return true; end if;
  if n_start > o_start or n_end < o_end then return true; end if;
  for d in select * from jsonb_array_elements(coalesce(p_old->'destinations', '[]'::jsonb)) loop
    if not exists (select 1 from jsonb_array_elements(coalesce(p_new->'destinations', '[]'::jsonb)) x
                   where x->>'destination_id' = d->>'destination_id') then
      return true; -- destination dropped
    end if;
    select nullif(x->>'min_rate_cents', '')::integer into v_new_min
      from jsonb_array_elements(p_new->'destinations') x where x->>'destination_id' = d->>'destination_id';
    if public._effective_min(p_driver, (d->>'destination_id')::uuid, v_new_min)
       > public._effective_min(p_driver, (d->>'destination_id')::uuid, nullif(d->>'min_rate_cents', '')::integer) then
      return true; -- minimum raised
    end if;
  end loop;
  if coalesce(p_old->>'vehicle_id', '') <> coalesce(p_new->>'vehicle_id', '') then
    select max_passengers into o_seats from public.vehicles where id = nullif(p_old->>'vehicle_id', '')::uuid;
    select max_passengers into n_seats from public.vehicles where id = nullif(p_new->>'vehicle_id', '')::uuid;
    if coalesce(n_seats, 0) < coalesce(o_seats, 0) then return true; end if;
  end if;
  return false;
end $$;

-- Does any recurring occurrence offering availability overlap [p_start, p_end)?
create or replace function public._recurring_overlaps(p_driver uuid, p_start timestamptz, p_end timestamptz)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.availability_rules r
    cross join lateral generate_series(
      ((p_start at time zone 'America/New_York')::date - 1)::timestamp,
      ((p_end at time zone 'America/New_York')::date)::timestamp, interval '1 day') g(day)
    where r.driver_id = p_driver and r.deleted_at is null and r.status <> 'UNAVAILABLE'
      and extract(isodow from g.day)::smallint = any(r.weekdays)
      and g.day::date >= r.effective_from and (r.effective_until is null or g.day::date <= r.effective_until)
      and not exists (select 1 from public.rule_exceptions e where e.rule_id = r.id and e.occurrence_date = g.day::date)
      and ((g.day::date + r.local_start) at time zone 'America/New_York') < p_end
      and (((g.day::date + r.end_day_offset) + r.local_end) at time zone 'America/New_York') > p_start
  );
$$;

create or replace function public._create_change_request(
  p_driver uuid, p_action public.change_request_action, p_target uuid, p_prior jsonb, p_proposed jsonb, p_message text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  begin
    insert into public.change_requests (driver_id, action, target_id, prior, proposed, driver_message)
    values (p_driver, p_action, p_target, p_prior, p_proposed, nullif(btrim(p_message), ''))
    returning id into v_id;
  exception when unique_violation then
    perform public.app_error('CONFLICT', 'A change to this item is already waiting for dispatcher approval.');
  end;
  perform public.write_audit('CHANGE_REQUESTED', 'change_requests', v_id::text, p_driver, p_prior,
    jsonb_build_object('action', p_action, 'proposed', p_proposed));
  return v_id;
end $$;

revoke all on function public._require_user() from public, authenticated;
revoke all on function public._require_approved_driver() from public, authenticated;
revoke all on function public._require_admin() from public, authenticated;
revoke all on function public._settings() from public, authenticated;
revoke all on function public.write_audit(text, text, text, uuid, jsonb, jsonb, text) from public, authenticated;
revoke all on function public._block_snapshot(uuid) from public, authenticated;
revoke all on function public._rule_snapshot(uuid) from public, authenticated;
revoke all on function public._validate_destinations(jsonb, boolean) from public, authenticated;
revoke all on function public._validate_vehicle_ref(uuid, uuid, public.availability_status) from public, authenticated;
revoke all on function public._validate_block(uuid, jsonb) from public, authenticated;
revoke all on function public._insert_block(uuid, jsonb, public.block_origin) from public, authenticated;
revoke all on function public._update_block(uuid, jsonb) from public, authenticated;
revoke all on function public._in_short_notice(timestamptz, timestamptz) from public, authenticated;
revoke all on function public._series_cutoff_date() from public, authenticated;
revoke all on function public._effective_min(uuid, uuid, integer) from public, authenticated;
revoke all on function public._block_change_reduces(uuid, jsonb, jsonb) from public, authenticated;
revoke all on function public._recurring_overlaps(uuid, timestamptz, timestamptz) from public, authenticated;
revoke all on function public._create_change_request(uuid, public.change_request_action, uuid, jsonb, jsonb, text) from public, authenticated;

-- ---------------------------------------------------------------------------
-- Sign-up: every new auth user gets a DRIVER role and a pending profile.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_require boolean;
begin
  select require_approval into v_require from public.app_settings where id = 1;
  insert into public.user_roles (user_id, role) values (new.id, 'DRIVER') on conflict (user_id) do nothing;
  insert into public.driver_profiles (user_id, email, full_name, status, status_changed_at)
  values (new.id, coalesce(new.email, ''), coalesce(left(new.raw_user_meta_data->>'full_name', 120), ''),
          case when coalesce(v_require, true) then 'PENDING_APPROVAL' else 'APPROVED' end::public.driver_status, now())
  on conflict (user_id) do nothing;
  if not coalesce(v_require, true) then
    insert into public.driver_destination_defaults (driver_id, destination_id, accepted, min_rate_cents)
    select new.id, d.id, true, d.preset_payout_cents from public.destinations d where d.is_active
    on conflict do nothing;
  end if;
  insert into public.notification_preferences (user_id, category, enabled)
  select new.id, c.code, c.default_on from public.notification_categories c
  on conflict do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

-- Keep the profile email in sync when a user changes their login email.
create or replace function public.handle_user_email_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.email is distinct from old.email then
    update public.driver_profiles set email = coalesce(new.email, '') where user_id = new.id;
  end if;
  return new;
end $$;

create trigger on_auth_user_email_changed
  after update of email on auth.users for each row execute function public.handle_user_email_change();

-- First admin: run once from the Supabase SQL editor (not callable by clients).
create or replace function public.bootstrap_admin(p_email text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  select id into v_id from auth.users where lower(email) = lower(btrim(p_email));
  if v_id is null then
    return 'No user with that email has signed in yet. Ask them to request a login link first.';
  end if;
  insert into public.user_roles (user_id, role) values (v_id, 'ADMIN')
    on conflict (user_id) do update set role = 'ADMIN';
  update public.driver_profiles set status = 'APPROVED', status_changed_at = now() where user_id = v_id;
  insert into public.audit_log (actor_role, action, entity_table, entity_id, affected_driver_id, after)
    values ('SYSTEM', 'BOOTSTRAP_ADMIN', 'user_roles', v_id::text, v_id, jsonb_build_object('role', 'ADMIN'));
  return 'Admin granted to ' || p_email;
end $$;
revoke all on function public.bootstrap_admin(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Driver: profile, vehicles, rate defaults
-- ---------------------------------------------------------------------------
create or replace function public.update_my_profile(
  p_full_name text, p_phone text, p_driver_notes text, p_expected_version integer
) returns public.driver_profiles language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public._require_user();
  v_row public.driver_profiles;
  v_before jsonb;
begin
  select * into v_row from public.driver_profiles where user_id = v_uid for update;
  if not found then perform public.app_error('NOT_FOUND', 'Profile not found.'); end if;
  if v_row.status in ('REJECTED', 'SUSPENDED') then perform public.app_error('FORBIDDEN', 'Your account is not active.'); end if;
  if v_row.version <> p_expected_version then perform public.app_error('CONFLICT', 'Your profile changed in another window. Reload and try again.'); end if;
  if p_full_name is null or char_length(btrim(p_full_name)) = 0 then perform public.app_error('VALIDATION', 'Enter your full name.'); end if;
  if char_length(p_full_name) > 120 then perform public.app_error('VALIDATION', 'Name is too long.'); end if;
  if p_phone is not null and btrim(p_phone) <> '' and btrim(p_phone) !~ '^[+0-9][0-9 ().-]{6,24}$' then
    perform public.app_error('VALIDATION', 'Phone number looks invalid.');
  end if;
  if char_length(coalesce(p_driver_notes, '')) > 1000 then perform public.app_error('VALIDATION', 'Notes are too long.'); end if;
  v_before := jsonb_build_object('full_name', v_row.full_name, 'phone', v_row.phone, 'driver_notes', v_row.driver_notes);
  -- Only these three columns can ever change here; status and role are untouchable.
  update public.driver_profiles
     set full_name = btrim(p_full_name), phone = nullif(btrim(p_phone), ''), driver_notes = nullif(btrim(p_driver_notes), '')
   where user_id = v_uid
  returning * into v_row;
  perform public.write_audit('PROFILE_UPDATED', 'driver_profiles', v_uid::text, v_uid, v_before,
    jsonb_build_object('full_name', v_row.full_name, 'phone', v_row.phone, 'driver_notes', v_row.driver_notes));
  return v_row;
end $$;

create or replace function public.complete_onboarding()
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := public._require_approved_driver();
begin
  update public.driver_profiles set onboarding_completed = true where user_id = v_uid;
end $$;

create or replace function public._save_vehicle(p_driver uuid, p jsonb, p_id uuid, p_expected_version integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := p_id;
  v_before jsonb;
  v_row public.vehicles;
  v_default boolean := coalesce((p->>'is_default')::boolean, false);
  v_type public.vehicle_type;
  v_pax integer;
  v_lug integer;
begin
  if char_length(btrim(coalesce(p->>'name', ''))) = 0 then perform public.app_error('VALIDATION', 'Give the vehicle a name.'); end if;
  begin
    v_type := coalesce(p->>'vehicle_type', 'SEDAN')::public.vehicle_type;
    v_pax := (p->>'max_passengers')::integer;
    v_lug := nullif(p->>'max_luggage', '')::integer;
  exception when others then
    perform public.app_error('VALIDATION', 'Vehicle type or capacity is invalid.');
  end;
  if v_pax is null or v_pax < 1 or v_pax > 60 then perform public.app_error('VALIDATION', 'Passenger capacity must be 1 to 60.'); end if;
  if v_lug is not null and (v_lug < 0 or v_lug > 100) then perform public.app_error('VALIDATION', 'Luggage capacity must be 0 to 100.'); end if;

  if v_id is null then
    if not exists (select 1 from public.vehicles where driver_id = p_driver and deleted_at is null) then v_default := true; end if;
    if v_default then update public.vehicles set is_default = false where driver_id = p_driver and is_default; end if;
    insert into public.vehicles (driver_id, name, make_model, vehicle_type, max_passengers, max_luggage, accessibility_notes, is_active, is_default)
    values (p_driver, btrim(p->>'name'), nullif(btrim(p->>'make_model'), ''), v_type, v_pax, v_lug,
            nullif(btrim(p->>'accessibility_notes'), ''), coalesce((p->>'is_active')::boolean, true), v_default)
    returning id into v_id;
    perform public.write_audit('VEHICLE_CREATED', 'vehicles', v_id::text, p_driver, null, to_jsonb((select x from public.vehicles x where x.id = v_id)));
  else
    select * into v_row from public.vehicles where id = v_id and driver_id = p_driver and deleted_at is null for update;
    if not found then perform public.app_error('NOT_FOUND', 'Vehicle not found.'); end if;
    if v_row.version <> p_expected_version then perform public.app_error('CONFLICT', 'This vehicle changed in another window. Reload and try again.'); end if;
    v_before := to_jsonb(v_row);
    if v_default then update public.vehicles set is_default = false where driver_id = p_driver and is_default and id <> v_id; end if;
    update public.vehicles set name = btrim(p->>'name'), make_model = nullif(btrim(p->>'make_model'), ''), vehicle_type = v_type,
      max_passengers = v_pax, max_luggage = v_lug, accessibility_notes = nullif(btrim(p->>'accessibility_notes'), ''),
      is_active = coalesce((p->>'is_active')::boolean, true), is_default = v_default
    where id = v_id;
    perform public.write_audit('VEHICLE_UPDATED', 'vehicles', v_id::text, p_driver, v_before, to_jsonb((select x from public.vehicles x where x.id = v_id)));
  end if;
  return v_id;
end $$;
revoke all on function public._save_vehicle(uuid, jsonb, uuid, integer) from public, authenticated;

create or replace function public.save_vehicle(p_vehicle jsonb, p_vehicle_id uuid default null, p_expected_version integer default null)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  return public._save_vehicle(public._require_approved_driver(), p_vehicle, p_vehicle_id, p_expected_version);
end $$;

-- Vehicles are archived, never hard-deleted, so past availability keeps its vehicle.
create or replace function public.archive_vehicle(p_vehicle_id uuid, p_expected_version integer)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public._require_approved_driver();
  v_row public.vehicles;
begin
  select * into v_row from public.vehicles where id = p_vehicle_id and driver_id = v_uid and deleted_at is null for update;
  if not found then perform public.app_error('NOT_FOUND', 'Vehicle not found.'); end if;
  if v_row.version <> p_expected_version then perform public.app_error('CONFLICT', 'This vehicle changed in another window. Reload and try again.'); end if;
  if exists (select 1 from public.availability_blocks where vehicle_id = p_vehicle_id and deleted_at is null and end_at > now())
     or exists (select 1 from public.availability_rules where vehicle_id = p_vehicle_id and deleted_at is null
                and (effective_until is null or effective_until >= (now() at time zone 'America/New_York')::date)) then
    perform public.app_error('VALIDATION', 'This vehicle is used in upcoming availability. Switch those blocks to another vehicle first.');
  end if;
  update public.vehicles set deleted_at = now(), is_active = false, is_default = false where id = p_vehicle_id;
  perform public.write_audit('VEHICLE_ARCHIVED', 'vehicles', p_vehicle_id::text, v_uid, to_jsonb(v_row), null);
end $$;

-- p_items: [{destination_id, accepted, min_rate_cents}]
create or replace function public.save_destination_defaults(p_items jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public._require_approved_driver();
  v_before jsonb;
begin
  if jsonb_typeof(p_items) <> 'array' then perform public.app_error('VALIDATION', 'Invalid destinations.'); end if;
  perform public._validate_destinations(
    (select coalesce(jsonb_agg(jsonb_build_object('destination_id', i->'destination_id', 'min_rate_cents', i->'min_rate_cents')), '[]'::jsonb)
     from jsonb_array_elements(p_items) i), false);
  select coalesce(jsonb_agg(to_jsonb(d) order by destination_id), '[]'::jsonb) into v_before
    from public.driver_destination_defaults d where driver_id = v_uid;
  insert into public.driver_destination_defaults (driver_id, destination_id, accepted, min_rate_cents)
  select v_uid, (i->>'destination_id')::uuid, coalesce((i->>'accepted')::boolean, true), nullif(i->>'min_rate_cents', '')::integer
  from jsonb_array_elements(p_items) i
  on conflict (driver_id, destination_id) do update
    set accepted = excluded.accepted, min_rate_cents = excluded.min_rate_cents;
  perform public.write_audit('RATES_UPDATED', 'driver_destination_defaults', v_uid::text, v_uid, v_before,
    (select coalesce(jsonb_agg(to_jsonb(d) order by destination_id), '[]'::jsonb) from public.driver_destination_defaults d where driver_id = v_uid));
end $$;

-- ---------------------------------------------------------------------------
-- Driver: availability blocks
-- ---------------------------------------------------------------------------
create or replace function public.save_block(p_block jsonb, p_block_id uuid default null, p_expected_version integer default null, p_message text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public._require_approved_driver();
  v_id uuid;
  v_old jsonb;
  v_req uuid;
  v_start timestamptz;
  v_end timestamptz;
begin
  perform public._validate_block(v_uid, p_block);
  v_start := (p_block->>'start_at')::timestamptz;
  v_end := (p_block->>'end_at')::timestamptz;

  if p_block_id is null then
    -- New UNAVAILABLE/TENTATIVE time inside the window that covers recurring availability is a reduction.
    if coalesce(p_block->>'status', 'AVAILABLE') <> 'AVAILABLE'
       and public._in_short_notice(v_start, v_end) and public._recurring_overlaps(v_uid, v_start, v_end) then
      v_req := public._create_change_request(v_uid, 'ADD_BLOCK', null, null, p_block, p_message);
      return jsonb_build_object('result', 'PENDING_APPROVAL', 'request_id', v_req);
    end if;
    v_id := public._insert_block(v_uid, p_block, 'DRIVER');
    perform public.write_audit('BLOCK_CREATED', 'availability_blocks', v_id::text, v_uid, null, public._block_snapshot(v_id));
    return jsonb_build_object('result', 'SAVED', 'block_id', v_id, 'version', 1);
  end if;

  perform 1 from public.availability_blocks where id = p_block_id and driver_id = v_uid and deleted_at is null for update;
  if not found then perform public.app_error('NOT_FOUND', 'That availability block no longer exists.'); end if;
  v_old := public._block_snapshot(p_block_id);
  if (v_old->>'version')::integer <> p_expected_version then
    perform public.app_error('CONFLICT', 'This block changed in another window. Reload to see the latest version.');
  end if;
  if public._in_short_notice((v_old->>'start_at')::timestamptz, (v_old->>'end_at')::timestamptz)
     and public._block_change_reduces(v_uid, v_old, p_block) then
    v_req := public._create_change_request(v_uid, 'UPDATE_BLOCK', p_block_id, v_old, p_block, p_message);
    return jsonb_build_object('result', 'PENDING_APPROVAL', 'request_id', v_req, 'block_id', p_block_id);
  end if;
  perform public._update_block(p_block_id, p_block);
  perform public.write_audit('BLOCK_UPDATED', 'availability_blocks', p_block_id::text, v_uid, v_old, public._block_snapshot(p_block_id));
  return jsonb_build_object('result', 'SAVED', 'block_id', p_block_id, 'version', (v_old->>'version')::integer + 1);
end $$;

create or replace function public.delete_block(p_block_id uuid, p_expected_version integer, p_message text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public._require_approved_driver();
  v_old jsonb;
  v_req uuid;
begin
  perform 1 from public.availability_blocks where id = p_block_id and driver_id = v_uid and deleted_at is null for update;
  if not found then perform public.app_error('NOT_FOUND', 'That availability block no longer exists.'); end if;
  v_old := public._block_snapshot(p_block_id);
  if (v_old->>'version')::integer <> p_expected_version then
    perform public.app_error('CONFLICT', 'This block changed in another window. Reload to see the latest version.');
  end if;
  if v_old->>'status' <> 'UNAVAILABLE'
     and public._in_short_notice((v_old->>'start_at')::timestamptz, (v_old->>'end_at')::timestamptz) then
    v_req := public._create_change_request(v_uid, 'DELETE_BLOCK', p_block_id, v_old, null, p_message);
    return jsonb_build_object('result', 'PENDING_APPROVAL', 'request_id', v_req);
  end if;
  update public.availability_blocks set deleted_at = now() where id = p_block_id;
  perform public.write_audit('BLOCK_DELETED', 'availability_blocks', p_block_id::text, v_uid, v_old, null);
  return jsonb_build_object('result', 'SAVED');
end $$;

-- Insert many new blocks at once (copy day/week, apply to weekdays, apply template).
-- p_skip_overlaps = true skips blocks that collide with existing ones and reports them.
create or replace function public.save_blocks_batch(p_blocks jsonb, p_origin public.block_origin default 'COPY', p_skip_overlaps boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public._require_approved_driver();
  b jsonb;
  v_id uuid;
  v_inserted uuid[] := '{}';
  v_skipped integer := 0;
  v_pending integer := 0;
begin
  if p_origin not in ('COPY', 'TEMPLATE', 'DRIVER') then perform public.app_error('VALIDATION', 'Invalid origin.'); end if;
  if jsonb_typeof(p_blocks) <> 'array' or jsonb_array_length(p_blocks) = 0 then perform public.app_error('VALIDATION', 'Nothing to save.'); end if;
  if jsonb_array_length(p_blocks) > 200 then perform public.app_error('VALIDATION', 'At most 200 blocks at once.'); end if;
  for b in select * from jsonb_array_elements(p_blocks) loop
    perform public._validate_block(v_uid, b - 'rule_id' - 'occurrence_date');
    if exists (select 1 from public.availability_blocks x where x.driver_id = v_uid and x.deleted_at is null
               and tstzrange(x.start_at, x.end_at, '[)') && tstzrange((b->>'start_at')::timestamptz, (b->>'end_at')::timestamptz, '[)')) then
      if p_skip_overlaps then v_skipped := v_skipped + 1; continue; end if;
      perform public.app_error('OVERLAP', 'One of these blocks overlaps existing availability.');
    end if;
    if coalesce(b->>'status', 'AVAILABLE') <> 'AVAILABLE'
       and public._in_short_notice((b->>'start_at')::timestamptz, (b->>'end_at')::timestamptz)
       and public._recurring_overlaps(v_uid, (b->>'start_at')::timestamptz, (b->>'end_at')::timestamptz) then
      perform public._create_change_request(v_uid, 'ADD_BLOCK', null, null, b - 'rule_id' - 'occurrence_date', null);
      v_pending := v_pending + 1;
      continue;
    end if;
    v_id := public._insert_block(v_uid, b - 'rule_id' - 'occurrence_date', p_origin);
    v_inserted := v_inserted || v_id;
  end loop;
  perform public.write_audit('BLOCKS_BATCH_CREATED', 'availability_blocks', null, v_uid, null,
    jsonb_build_object('origin', p_origin, 'block_ids', to_jsonb(v_inserted), 'skipped', v_skipped, 'pending', v_pending));
  return jsonb_build_object('inserted', cardinality(v_inserted), 'skipped', v_skipped, 'pending', v_pending, 'block_ids', to_jsonb(v_inserted));
end $$;

-- ---------------------------------------------------------------------------
-- Driver: recurring rules, exceptions, time off
-- ---------------------------------------------------------------------------
create or replace function public._validate_rule(p_driver uuid, p jsonb)
returns void language plpgsql stable security definer set search_path = '' as $$
declare
  v_days smallint[];
  v_s time; v_e time; v_off smallint; v_from date; v_until date;
  v_status public.availability_status;
begin
  begin
    v_days := array(select jsonb_array_elements_text(p->'weekdays')::smallint);
    v_s := (p->>'local_start')::time; v_e := (p->>'local_end')::time;
    v_off := coalesce((p->>'end_day_offset')::smallint, 0);
    v_from := (p->>'effective_from')::date; v_until := nullif(p->>'effective_until', '')::date;
    v_status := coalesce(p->>'status', 'AVAILABLE')::public.availability_status;
  exception when others then
    perform public.app_error('VALIDATION', 'The weekly schedule has an invalid value.');
  end;
  if cardinality(v_days) = 0 then perform public.app_error('VALIDATION', 'Pick at least one day.'); end if;
  if exists (select 1 from unnest(v_days) d where d < 1 or d > 7) then perform public.app_error('VALIDATION', 'Days must be Monday through Sunday.'); end if;
  if (select count(distinct d) from unnest(v_days) d) <> cardinality(v_days) then perform public.app_error('VALIDATION', 'A day is listed twice.'); end if;
  if v_s is null or v_e is null or v_from is null then perform public.app_error('VALIDATION', 'Start time, end time and start date are required.'); end if;
  if v_off = 0 and v_e <= v_s then perform public.app_error('VALIDATION', 'End time must be after start time, or mark it as ending the next day.'); end if;
  if v_off = 1 and v_e > v_s then perform public.app_error('VALIDATION', 'An overnight shift cannot be longer than 24 hours.'); end if;
  if v_until is not null and v_until < v_from then perform public.app_error('VALIDATION', 'End date is before start date.'); end if;
  perform public._validate_vehicle_ref(p_driver, nullif(p->>'vehicle_id', '')::uuid, v_status);
  perform public._validate_destinations(p->'destinations', v_status <> 'UNAVAILABLE');
end $$;
revoke all on function public._validate_rule(uuid, jsonb) from public, authenticated;

create or replace function public._insert_rule(p_driver uuid, p jsonb, p_from date)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  insert into public.availability_rules (driver_id, weekdays, local_start, local_end, end_day_offset, effective_from, effective_until,
    status, vehicle_id, notes)
  values (p_driver, array(select jsonb_array_elements_text(p->'weekdays')::smallint), (p->>'local_start')::time, (p->>'local_end')::time,
    coalesce((p->>'end_day_offset')::smallint, 0), p_from, nullif(p->>'effective_until', '')::date,
    coalesce(p->>'status', 'AVAILABLE')::public.availability_status,
    case when coalesce(p->>'status', 'AVAILABLE') = 'UNAVAILABLE' then null else nullif(p->>'vehicle_id', '')::uuid end,
    nullif(btrim(p->>'notes'), ''))
  returning id into v_id;
  if coalesce(p->>'status', 'AVAILABLE') <> 'UNAVAILABLE' then
    insert into public.availability_rule_destinations (rule_id, destination_id, min_rate_cents)
    select v_id, (d->>'destination_id')::uuid, nullif(d->>'min_rate_cents', '')::integer
    from jsonb_array_elements(coalesce(p->'destinations', '[]'::jsonb)) d;
  end if;
  return v_id;
end $$;
revoke all on function public._insert_rule(uuid, jsonb, date) from public, authenticated;

-- Create or edit a weekly schedule. Editing an existing series never rewrites
-- past days or days inside the short-notice window: the old series ends the
-- day before the cutoff and the edited series starts on the cutoff date.
create or replace function public.save_rule(p_rule jsonb, p_rule_id uuid default null, p_expected_version integer default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public._require_approved_driver();
  v_old jsonb;
  v_cutoff date := public._series_cutoff_date();
  v_from date;
  v_new uuid;
begin
  perform public._validate_rule(v_uid, p_rule);
  v_from := (p_rule->>'effective_from')::date;

  if p_rule_id is null then
    v_new := public._insert_rule(v_uid, p_rule, v_from);
    perform public.write_audit('RULE_CREATED', 'availability_rules', v_new::text, v_uid, null, public._rule_snapshot(v_new));
    return jsonb_build_object('result', 'SAVED', 'rule_id', v_new, 'effective_from', v_from);
  end if;

  perform 1 from public.availability_rules where id = p_rule_id and driver_id = v_uid and deleted_at is null for update;
  if not found then perform public.app_error('NOT_FOUND', 'That weekly schedule no longer exists.'); end if;
  v_old := public._rule_snapshot(p_rule_id);
  if (v_old->>'version')::integer <> p_expected_version then
    perform public.app_error('CONFLICT', 'This schedule changed in another window. Reload and try again.');
  end if;

  if (v_old->>'effective_from')::date >= v_cutoff then
    -- Entirely in the future: edit in place.
    update public.availability_rules set
      weekdays = array(select jsonb_array_elements_text(p_rule->'weekdays')::smallint),
      local_start = (p_rule->>'local_start')::time, local_end = (p_rule->>'local_end')::time,
      end_day_offset = coalesce((p_rule->>'end_day_offset')::smallint, 0),
      effective_from = greatest(v_from, v_cutoff), effective_until = nullif(p_rule->>'effective_until', '')::date,
      status = coalesce(p_rule->>'status', 'AVAILABLE')::public.availability_status,
      vehicle_id = case when coalesce(p_rule->>'status', 'AVAILABLE') = 'UNAVAILABLE' then null else nullif(p_rule->>'vehicle_id', '')::uuid end,
      notes = nullif(btrim(p_rule->>'notes'), '')
    where id = p_rule_id;
    delete from public.availability_rule_destinations where rule_id = p_rule_id;
    if coalesce(p_rule->>'status', 'AVAILABLE') <> 'UNAVAILABLE' then
      insert into public.availability_rule_destinations (rule_id, destination_id, min_rate_cents)
      select p_rule_id, (d->>'destination_id')::uuid, nullif(d->>'min_rate_cents', '')::integer
      from jsonb_array_elements(coalesce(p_rule->'destinations', '[]'::jsonb)) d;
    end if;
    perform public.write_audit('RULE_UPDATED', 'availability_rules', p_rule_id::text, v_uid, v_old, public._rule_snapshot(p_rule_id));
    return jsonb_build_object('result', 'SAVED', 'rule_id', p_rule_id, 'effective_from', greatest(v_from, v_cutoff));
  end if;

  -- Split: keep the past and the short-notice window on the old series.
  update public.availability_rules set effective_until = v_cutoff - 1 where id = p_rule_id;
  if (v_old->>'effective_until') is null or (v_old->>'effective_until')::date >= v_cutoff then
    v_new := public._insert_rule(v_uid, p_rule, greatest(v_from, v_cutoff));
    update public.rule_exceptions set rule_id = v_new where rule_id = p_rule_id and occurrence_date >= v_cutoff;
    update public.availability_blocks set rule_id = v_new where rule_id = p_rule_id and occurrence_date >= v_cutoff;
  end if;
  perform public.write_audit('RULE_SPLIT', 'availability_rules', p_rule_id::text, v_uid, v_old,
    jsonb_build_object('old_rule_until', v_cutoff - 1, 'new_rule', case when v_new is null then null else public._rule_snapshot(v_new) end));
  return jsonb_build_object('result', 'SAVED', 'rule_id', coalesce(v_new, p_rule_id), 'effective_from', greatest(v_from, v_cutoff),
    'kept_until', v_cutoff - 1);
end $$;

-- End a weekly schedule. Days before the cutoff keep it (past and short-notice window).
create or replace function public.end_rule(p_rule_id uuid, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public._require_approved_driver();
  v_old jsonb;
  v_cutoff date := public._series_cutoff_date();
begin
  perform 1 from public.availability_rules where id = p_rule_id and driver_id = v_uid and deleted_at is null for update;
  if not found then perform public.app_error('NOT_FOUND', 'That weekly schedule no longer exists.'); end if;
  v_old := public._rule_snapshot(p_rule_id);
  if (v_old->>'version')::integer <> p_expected_version then
    perform public.app_error('CONFLICT', 'This schedule changed in another window. Reload and try again.');
  end if;
  if (v_old->>'effective_from')::date >= v_cutoff then
    update public.availability_rules set deleted_at = now() where id = p_rule_id;
  else
    update public.availability_rules set effective_until = least(coalesce(effective_until, v_cutoff - 1), v_cutoff - 1) where id = p_rule_id;
  end if;
  perform public.write_audit('RULE_ENDED', 'availability_rules', p_rule_id::text, v_uid, v_old, public._rule_snapshot(p_rule_id));
  return jsonb_build_object('result', 'SAVED', 'kept_until', case when (v_old->>'effective_from')::date >= v_cutoff then null else v_cutoff - 1 end);
end $$;

-- Remove one occurrence of a weekly schedule ("this day only").
create or replace function public.skip_occurrence(p_rule_id uuid, p_date date, p_message text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public._require_approved_driver();
  r public.availability_rules;
  v_start timestamptz;
  v_end timestamptz;
  v_req uuid;
begin
  select * into r from public.availability_rules where id = p_rule_id and driver_id = v_uid and deleted_at is null;
  if not found then perform public.app_error('NOT_FOUND', 'That weekly schedule no longer exists.'); end if;
  if not (extract(isodow from p_date)::smallint = any(r.weekdays)) or p_date < r.effective_from
     or (r.effective_until is not null and p_date > r.effective_until) then
    perform public.app_error('VALIDATION', 'That schedule does not run on this date.');
  end if;
  v_start := (p_date + r.local_start) at time zone 'America/New_York';
  v_end := ((p_date + r.end_day_offset) + r.local_end) at time zone 'America/New_York';
  if r.status <> 'UNAVAILABLE' and public._in_short_notice(v_start, v_end) then
    v_req := public._create_change_request(v_uid, 'SKIP_OCCURRENCE', p_rule_id, public._rule_snapshot(p_rule_id),
      jsonb_build_object('rule_id', p_rule_id, 'occurrence_date', p_date), p_message);
    return jsonb_build_object('result', 'PENDING_APPROVAL', 'request_id', v_req);
  end if;
  insert into public.rule_exceptions (rule_id, occurrence_date, created_by) values (p_rule_id, p_date, v_uid)
    on conflict (rule_id, occurrence_date) do nothing;
  perform public.write_audit('OCCURRENCE_SKIPPED', 'rule_exceptions', p_rule_id::text, v_uid, null,
    jsonb_build_object('rule_id', p_rule_id, 'occurrence_date', p_date));
  return jsonb_build_object('result', 'SAVED');
end $$;

create or replace function public.restore_occurrence(p_rule_id uuid, p_date date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := public._require_approved_driver();
begin
  if not exists (select 1 from public.availability_rules where id = p_rule_id and driver_id = v_uid) then
    perform public.app_error('NOT_FOUND', 'That weekly schedule no longer exists.');
  end if;
  delete from public.rule_exceptions where rule_id = p_rule_id and occurrence_date = p_date;
  perform public.write_audit('OCCURRENCE_RESTORED', 'rule_exceptions', p_rule_id::text, v_uid,
    jsonb_build_object('rule_id', p_rule_id, 'occurrence_date', p_date), null);
  return jsonb_build_object('result', 'SAVED');
end $$;

create or replace function public.save_time_off(p_start date, p_end date, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public._require_approved_driver();
  v_id uuid;
  v_req uuid;
  v_payload jsonb := jsonb_build_object('start_date', p_start, 'end_date', p_end, 'note', p_note);
begin
  if p_start is null or p_end is null then perform public.app_error('VALIDATION', 'Start and end dates are required.'); end if;
  if p_end < p_start then perform public.app_error('VALIDATION', 'End date is before start date.'); end if;
  if p_end - p_start > 366 then perform public.app_error('VALIDATION', 'Time off can be at most one year at a time.'); end if;
  if char_length(coalesce(p_note, '')) > 500 then perform public.app_error('VALIDATION', 'Note is too long.'); end if;
  if public._in_short_notice(p_start::timestamp at time zone 'America/New_York', (p_end + 1)::timestamp at time zone 'America/New_York') then
    v_req := public._create_change_request(v_uid, 'ADD_TIME_OFF', null, null, v_payload, null);
    return jsonb_build_object('result', 'PENDING_APPROVAL', 'request_id', v_req);
  end if;
  insert into public.time_off (driver_id, start_date, end_date, note, created_by)
  values (v_uid, p_start, p_end, nullif(btrim(p_note), ''), v_uid) returning id into v_id;
  return jsonb_build_object('result', 'SAVED', 'time_off_id', v_id);
end $$;

create or replace function public.delete_time_off(p_id uuid, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public._require_approved_driver();
  v_row public.time_off;
begin
  select * into v_row from public.time_off where id = p_id and driver_id = v_uid and deleted_at is null for update;
  if not found then perform public.app_error('NOT_FOUND', 'That time off no longer exists.'); end if;
  if v_row.version <> p_expected_version then perform public.app_error('CONFLICT', 'This time off changed in another window. Reload and try again.'); end if;
  update public.time_off set deleted_at = now() where id = p_id;
  return jsonb_build_object('result', 'SAVED');
end $$;

-- Clear one-off blocks starting in [p_from, p_to] and optionally skip recurring occurrences.
create or replace function public.clear_range(p_from date, p_to date, p_include_recurring boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public._require_approved_driver();
  b record;
  r record;
  v_res jsonb;
  v_deleted integer := 0;
  v_skipped integer := 0;
  v_pending integer := 0;
begin
  if p_to < p_from or p_to - p_from > 31 then perform public.app_error('VALIDATION', 'Choose a range of up to one month.'); end if;
  for b in select id, version from public.availability_blocks
           where driver_id = v_uid and deleted_at is null
             and (start_at at time zone 'America/New_York')::date between p_from and p_to loop
    v_res := public.delete_block(b.id, b.version);
    if v_res->>'result' = 'PENDING_APPROVAL' then v_pending := v_pending + 1; else v_deleted := v_deleted + 1; end if;
  end loop;
  if p_include_recurring then
    for r in select ru.id as rule_id, g.day::date as d
             from public.availability_rules ru
             cross join lateral generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g(day)
             where ru.driver_id = v_uid and ru.deleted_at is null
               and extract(isodow from g.day)::smallint = any(ru.weekdays)
               and g.day::date >= ru.effective_from and (ru.effective_until is null or g.day::date <= ru.effective_until)
               and not exists (select 1 from public.rule_exceptions e where e.rule_id = ru.id and e.occurrence_date = g.day::date) loop
      v_res := public.skip_occurrence(r.rule_id, r.d);
      if v_res->>'result' = 'PENDING_APPROVAL' then v_pending := v_pending + 1; else v_skipped := v_skipped + 1; end if;
    end loop;
  end if;
  return jsonb_build_object('deleted', v_deleted, 'skipped_occurrences', v_skipped, 'pending', v_pending);
end $$;

-- ---------------------------------------------------------------------------
-- Driver: templates, change requests, notifications, settings
-- ---------------------------------------------------------------------------
create or replace function public.save_template(p_name text, p_span text, p_blocks jsonb, p_template_id uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public._require_approved_driver();
  v_id uuid;
  b jsonb;
begin
  if char_length(btrim(coalesce(p_name, ''))) = 0 then perform public.app_error('VALIDATION', 'Give the template a name.'); end if;
  if p_span not in ('DAY', 'WEEK') then perform public.app_error('VALIDATION', 'Invalid template type.'); end if;
  if jsonb_typeof(p_blocks) <> 'array' or jsonb_array_length(p_blocks) not between 1 and 100 then
    perform public.app_error('VALIDATION', 'A template needs 1 to 100 blocks.');
  end if;
  for b in select * from jsonb_array_elements(p_blocks) loop
    if (b->>'dayOffset')::integer not between 0 and 6
       or (b->>'localStart') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or (b->>'localEnd') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or coalesce(b->>'status', '') not in ('AVAILABLE', 'TENTATIVE', 'UNAVAILABLE') then
      perform public.app_error('VALIDATION', 'A template block is invalid.');
    end if;
  end loop;
  begin
    if p_template_id is null then
      insert into public.schedule_templates (driver_id, name, span, blocks) values (v_uid, btrim(p_name), p_span, p_blocks) returning id into v_id;
    else
      update public.schedule_templates set name = btrim(p_name), span = p_span, blocks = p_blocks
       where id = p_template_id and driver_id = v_uid returning id into v_id;
      if v_id is null then perform public.app_error('NOT_FOUND', 'Template not found.'); end if;
    end if;
  exception when unique_violation then
    perform public.app_error('VALIDATION', 'You already have a template with that name.');
  end;
  return v_id;
end $$;

create or replace function public.delete_template(p_template_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := public._require_approved_driver();
begin
  delete from public.schedule_templates where id = p_template_id and driver_id = v_uid;
end $$;

create or replace function public.withdraw_change_request(p_request_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := public._require_approved_driver();
begin
  update public.change_requests set status = 'WITHDRAWN', decided_at = now(), decided_by = v_uid
   where id = p_request_id and driver_id = v_uid and status = 'PENDING';
  if not found then perform public.app_error('NOT_FOUND', 'That request is no longer pending.'); end if;
end $$;

create or replace function public.set_notification_preference(p_category text, p_enabled boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := public._require_user();
begin
  if not exists (select 1 from public.notification_categories where code = p_category) then
    perform public.app_error('VALIDATION', 'Unknown notification type.');
  end if;
  insert into public.notification_preferences (user_id, category, enabled) values (v_uid, p_category, p_enabled)
  on conflict (user_id, category) do update set enabled = excluded.enabled, updated_at = now();
end $$;

-- Settings a driver may see (never buffers, payout rules or sync data).
create or replace function public.get_public_settings()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'environment', s.environment,
    'congestion_surcharge_cents', s.congestion_surcharge_cents,
    'short_notice_window_hours', s.short_notice_window_hours,
    'submission_deadline_dow', s.submission_deadline_dow,
    'submission_deadline_time', to_char(s.submission_deadline_time, 'HH24:MI'))
  from public.app_settings s where s.id = 1 and (public.is_approved_driver() or public.is_admin());
$$;

-- Administrator changes that affected the calling driver's availability.
create or replace function public.my_admin_changes(p_limit integer default 50)
returns table (id bigint, action text, entity_table text, reason text, before jsonb, after jsonb, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select a.id, a.action, a.entity_table, a.reason, a.before, a.after, a.created_at
  from public.audit_log a
  where a.affected_driver_id = (select auth.uid()) and public.is_approved_driver()
    and a.actor_role = 'ADMIN'
    and a.entity_table in ('availability_blocks', 'availability_rules', 'rule_exceptions', 'time_off', 'admin_unavailability', 'change_requests')
  order by a.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

-- ---------------------------------------------------------------------------
-- Admin
-- ---------------------------------------------------------------------------
create or replace function public.set_driver_status(p_driver uuid, p_status public.driver_status, p_reason text default null)
returns public.driver_profiles language plpgsql security definer set search_path = '' as $$
declare
  v_admin uuid := public._require_admin();
  v_row public.driver_profiles;
  v_before public.driver_status;
begin
  select * into v_row from public.driver_profiles where user_id = p_driver for update;
  if not found then perform public.app_error('NOT_FOUND', 'Driver not found.'); end if;
  if p_driver = v_admin and p_status <> 'APPROVED' then perform public.app_error('VALIDATION', 'You cannot deactivate your own account.'); end if;
  if p_status = 'PENDING_APPROVAL' then perform public.app_error('VALIDATION', 'Choose approve, reject, suspend or reactivate.'); end if;
  v_before := v_row.status;
  update public.driver_profiles set status = p_status, status_reason = nullif(btrim(p_reason), ''), status_changed_at = now(),
    status_changed_by = v_admin where user_id = p_driver returning * into v_row;
  if p_status = 'APPROVED' then
    insert into public.driver_destination_defaults (driver_id, destination_id, accepted, min_rate_cents)
    select p_driver, d.id, true, d.preset_payout_cents from public.destinations d where d.is_active
    on conflict do nothing;
  end if;
  perform public.write_audit('DRIVER_STATUS_CHANGED', 'driver_profiles', p_driver::text, p_driver,
    jsonb_build_object('status', v_before), jsonb_build_object('status', p_status), p_reason);
  return v_row;
end $$;

create or replace function public.admin_save_block(p_driver uuid, p_block jsonb, p_block_id uuid default null,
  p_expected_version integer default null, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_admin uuid := public._require_admin();
  v_id uuid;
  v_old jsonb;
begin
  if not exists (select 1 from public.driver_profiles where user_id = p_driver) then perform public.app_error('NOT_FOUND', 'Driver not found.'); end if;
  perform public._validate_block(p_driver, p_block);
  if p_block_id is null then
    v_id := public._insert_block(p_driver, p_block, 'ADMIN');
    perform public.write_audit('BLOCK_CREATED', 'availability_blocks', v_id::text, p_driver, null, public._block_snapshot(v_id), p_reason);
    return jsonb_build_object('result', 'SAVED', 'block_id', v_id, 'version', 1);
  end if;
  perform 1 from public.availability_blocks where id = p_block_id and driver_id = p_driver and deleted_at is null for update;
  if not found then perform public.app_error('NOT_FOUND', 'That availability block no longer exists.'); end if;
  v_old := public._block_snapshot(p_block_id);
  if (v_old->>'version')::integer <> p_expected_version then
    perform public.app_error('CONFLICT', 'This block changed since you opened it. Reload to see the latest version.');
  end if;
  perform public._update_block(p_block_id, p_block);
  perform public.write_audit('BLOCK_UPDATED', 'availability_blocks', p_block_id::text, p_driver, v_old, public._block_snapshot(p_block_id), p_reason);
  return jsonb_build_object('result', 'SAVED', 'block_id', p_block_id, 'version', (v_old->>'version')::integer + 1);
end $$;

create or replace function public.admin_delete_block(p_block_id uuid, p_expected_version integer, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_admin uuid := public._require_admin();
  v_old jsonb;
begin
  perform 1 from public.availability_blocks where id = p_block_id and deleted_at is null for update;
  if not found then perform public.app_error('NOT_FOUND', 'That availability block no longer exists.'); end if;
  v_old := public._block_snapshot(p_block_id);
  if (v_old->>'version')::integer <> p_expected_version then
    perform public.app_error('CONFLICT', 'This block changed since you opened it. Reload to see the latest version.');
  end if;
  update public.availability_blocks set deleted_at = now() where id = p_block_id;
  perform public.write_audit('BLOCK_DELETED', 'availability_blocks', p_block_id::text, (v_old->>'driver_id')::uuid, v_old, null, p_reason);
  return jsonb_build_object('result', 'SAVED');
end $$;

create or replace function public.admin_mark_unavailable(p_driver uuid, p_start timestamptz, p_end timestamptz, p_reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_admin uuid := public._require_admin();
  v_id uuid;
begin
  if not exists (select 1 from public.driver_profiles where user_id = p_driver) then perform public.app_error('NOT_FOUND', 'Driver not found.'); end if;
  if p_end <= p_start then perform public.app_error('VALIDATION', 'End must be after start.'); end if;
  if p_end - p_start > interval '31 days' then perform public.app_error('VALIDATION', 'At most 31 days at a time.'); end if;
  insert into public.admin_unavailability (driver_id, start_at, end_at, reason, created_by)
  values (p_driver, p_start, p_end, nullif(btrim(p_reason), ''), v_admin) returning id into v_id;
  return v_id;
end $$;

create or replace function public.admin_clear_unavailable(p_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_admin uuid := public._require_admin();
begin
  perform set_config('app.audit_reason', coalesce(p_reason, ''), true);
  update public.admin_unavailability set deleted_at = now() where id = p_id and deleted_at is null;
  if not found then perform public.app_error('NOT_FOUND', 'Already cleared.'); end if;
end $$;

-- Approve or reject a short-notice change. Approval applies the proposed change.
create or replace function public.decide_change_request(p_request_id uuid, p_approve boolean, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_admin uuid := public._require_admin();
  cr public.change_requests;
  v_current jsonb;
  v_id uuid;
begin
  select * into cr from public.change_requests where id = p_request_id for update;
  if not found or cr.status <> 'PENDING' then perform public.app_error('NOT_FOUND', 'That request is no longer pending.'); end if;
  perform set_config('app.audit_reason', coalesce(p_reason, ''), true);

  if p_approve then
    case cr.action
      when 'ADD_BLOCK' then
        perform public._validate_block(cr.driver_id, cr.proposed);
        v_id := public._insert_block(cr.driver_id, cr.proposed, 'DRIVER');
        perform public.write_audit('BLOCK_CREATED', 'availability_blocks', v_id::text, cr.driver_id, null, public._block_snapshot(v_id), p_reason);
      when 'UPDATE_BLOCK' then
        v_current := public._block_snapshot(cr.target_id);
        if v_current is null or (v_current->>'deleted_at') is not null or v_current->>'version' <> cr.prior->>'version' then
          perform public.app_error('STALE', 'The block changed after this request was made. Reject it and ask the driver to resubmit.');
        end if;
        perform public._validate_block(cr.driver_id, cr.proposed);
        perform public._update_block(cr.target_id, cr.proposed);
        perform public.write_audit('BLOCK_UPDATED', 'availability_blocks', cr.target_id::text, cr.driver_id, v_current, public._block_snapshot(cr.target_id), p_reason);
      when 'DELETE_BLOCK' then
        v_current := public._block_snapshot(cr.target_id);
        if v_current is null or (v_current->>'deleted_at') is not null or v_current->>'version' <> cr.prior->>'version' then
          perform public.app_error('STALE', 'The block changed after this request was made. Reject it and ask the driver to resubmit.');
        end if;
        update public.availability_blocks set deleted_at = now() where id = cr.target_id;
        perform public.write_audit('BLOCK_DELETED', 'availability_blocks', cr.target_id::text, cr.driver_id, v_current, null, p_reason);
      when 'ADD_TIME_OFF' then
        insert into public.time_off (driver_id, start_date, end_date, note, created_by)
        values (cr.driver_id, (cr.proposed->>'start_date')::date, (cr.proposed->>'end_date')::date, nullif(cr.proposed->>'note', ''), cr.driver_id);
      when 'SKIP_OCCURRENCE' then
        insert into public.rule_exceptions (rule_id, occurrence_date, created_by)
        values ((cr.proposed->>'rule_id')::uuid, (cr.proposed->>'occurrence_date')::date, cr.driver_id)
        on conflict do nothing;
    end case;
  end if;

  update public.change_requests set status = case when p_approve then 'APPROVED' else 'REJECTED' end::public.change_request_status,
    decided_by = v_admin, decided_at = now(), decision_reason = nullif(btrim(p_reason), '')
  where id = p_request_id;
  return jsonb_build_object('result', case when p_approve then 'APPROVED' else 'REJECTED' end);
end $$;

create or replace function public.set_eligibility_override(p_reservation uuid, p_driver uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_admin uuid := public._require_admin();
  v_id uuid;
begin
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then perform public.app_error('VALIDATION', 'Give a reason for the override.'); end if;
  begin
    insert into public.eligibility_overrides (reservation_id, driver_id, reason, created_by)
    values (p_reservation, p_driver, btrim(p_reason), v_admin) returning id into v_id;
  exception when unique_violation then
    perform public.app_error('CONFLICT', 'An override already exists for this driver and trip.');
  end;
  return v_id;
end $$;

create or replace function public.revoke_eligibility_override(p_override_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_admin uuid := public._require_admin();
begin
  update public.eligibility_overrides set revoked_at = now(), revoked_by = v_admin where id = p_override_id and revoked_at is null;
  if not found then perform public.app_error('NOT_FOUND', 'Override not found.'); end if;
end $$;

-- Driver directory used by the reservation parser (admin only).
create or replace function public.admin_driver_directory()
returns table (driver_id uuid, full_name text, email text, aliases text[])
language sql stable security definer set search_path = '' as $$
  select p.user_id, p.full_name, p.email,
    coalesce(array(select a.alias from public.driver_aliases a where a.driver_id = p.user_id order by a.alias), '{}')
  from public.driver_profiles p
  where public.is_admin() and p.status in ('APPROVED', 'SUSPENDED');
$$;

-- ---------------------------------------------------------------------------
-- Execute grants: clients may call only these.
-- ---------------------------------------------------------------------------
revoke all on function public.update_my_profile(text, text, text, integer) from public;
revoke all on function public.complete_onboarding() from public;
revoke all on function public.save_vehicle(jsonb, uuid, integer) from public;
revoke all on function public.archive_vehicle(uuid, integer) from public;
revoke all on function public.save_destination_defaults(jsonb) from public;
revoke all on function public.save_block(jsonb, uuid, integer, text) from public;
revoke all on function public.delete_block(uuid, integer, text) from public;
revoke all on function public.save_blocks_batch(jsonb, public.block_origin, boolean) from public;
revoke all on function public.save_rule(jsonb, uuid, integer) from public;
revoke all on function public.end_rule(uuid, integer) from public;
revoke all on function public.skip_occurrence(uuid, date, text) from public;
revoke all on function public.restore_occurrence(uuid, date) from public;
revoke all on function public.save_time_off(date, date, text) from public;
revoke all on function public.delete_time_off(uuid, integer) from public;
revoke all on function public.clear_range(date, date, boolean) from public;
revoke all on function public.save_template(text, text, jsonb, uuid) from public;
revoke all on function public.delete_template(uuid) from public;
revoke all on function public.withdraw_change_request(uuid) from public;
revoke all on function public.set_notification_preference(text, boolean) from public;
revoke all on function public.get_public_settings() from public;
revoke all on function public.my_admin_changes(integer) from public;
revoke all on function public.set_driver_status(uuid, public.driver_status, text) from public;
revoke all on function public.admin_save_block(uuid, jsonb, uuid, integer, text) from public;
revoke all on function public.admin_delete_block(uuid, integer, text) from public;
revoke all on function public.admin_mark_unavailable(uuid, timestamptz, timestamptz, text) from public;
revoke all on function public.admin_clear_unavailable(uuid, text) from public;
revoke all on function public.decide_change_request(uuid, boolean, text) from public;
revoke all on function public.set_eligibility_override(uuid, uuid, text) from public;
revoke all on function public.revoke_eligibility_override(uuid) from public;
revoke all on function public.admin_driver_directory() from public;
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.handle_user_email_change() from public, anon, authenticated;
revoke all on function public.app_error(text, text) from public, anon, authenticated;
revoke all on function public.tg_touch_row() from public, anon, authenticated;
revoke all on function public._redact(jsonb) from public, anon, authenticated;
revoke all on function public._status_rank(text) from public, anon, authenticated;

grant execute on function
  public.update_my_profile(text, text, text, integer),
  public.complete_onboarding(),
  public.save_vehicle(jsonb, uuid, integer),
  public.archive_vehicle(uuid, integer),
  public.save_destination_defaults(jsonb),
  public.save_block(jsonb, uuid, integer, text),
  public.delete_block(uuid, integer, text),
  public.save_blocks_batch(jsonb, public.block_origin, boolean),
  public.save_rule(jsonb, uuid, integer),
  public.end_rule(uuid, integer),
  public.skip_occurrence(uuid, date, text),
  public.restore_occurrence(uuid, date),
  public.save_time_off(date, date, text),
  public.delete_time_off(uuid, integer),
  public.clear_range(date, date, boolean),
  public.save_template(text, text, jsonb, uuid),
  public.delete_template(uuid),
  public.withdraw_change_request(uuid),
  public.set_notification_preference(text, boolean),
  public.get_public_settings(),
  public.my_admin_changes(integer),
  public.set_driver_status(uuid, public.driver_status, text),
  public.admin_save_block(uuid, jsonb, uuid, integer, text),
  public.admin_delete_block(uuid, integer, text),
  public.admin_mark_unavailable(uuid, timestamptz, timestamptz, text),
  public.admin_clear_unavailable(uuid, text),
  public.decide_change_request(uuid, boolean, text),
  public.set_eligibility_override(uuid, uuid, text),
  public.revoke_eligibility_override(uuid),
  public.admin_driver_directory()
to authenticated;
