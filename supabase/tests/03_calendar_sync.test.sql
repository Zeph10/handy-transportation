-- Google Calendar sync: criteria 14, 15, 16 and the integration's safety rules.

select set_config('t.admin', tests.new_user('admin3@t.test')::text, false);
select set_config('t.d', tests.new_user('drv3@t.test')::text, false);
select public.bootstrap_admin('admin3@t.test');
update public.driver_profiles set status = 'APPROVED', full_name = 'Dana Driver' where user_id = current_setting('t.d')::uuid;

-- OAuth callback stores the connection (service role); the admin picks the calendar.
select set_config('t.conn', public.store_calendar_connection(current_setting('t.admin')::uuid, 'support@example.test',
  array['https://www.googleapis.com/auth/calendar.events.readonly'], 'refresh-token-value-123')::text, false);
select tests.throws($$select public.store_calendar_connection(current_setting('t.d')::uuid, 'x', '{}', 'refresh-token-value-123')$$, 'FORBIDDEN', 'only admins can connect');
select tests.login(current_setting('t.admin')::uuid);
select public.admin_set_calendar('support@example.test', 'Reservations');
do $$ begin
  perform tests.eq((select status::text from public.calendar_connections), 'CONNECTED', 'connected');
  perform tests.ok((public.admin_sync_status()->>'stale')::boolean, 'never synced counts as stale');
end $$;
select tests.throws($$select public.sync_begin(auth.uid())$$, '42501', 'browser cannot start a sync directly');
select tests.throws($$select public.sync_get_refresh_token(current_setting('t.conn')::uuid)$$, '42501', 'browser cannot read the token');
select tests.logout();

-- The refresh token never reaches the audit log
do $$ begin
  perform tests.ok(not exists (select 1 from public.audit_log where after::text like '%refresh-token-value%' or before::text like '%refresh-token-value%'), 'token not in audit');
  perform tests.ok(exists (select 1 from public.audit_log where entity_table = 'calendar_connections' and after->>'vault_secret_id' = '[redacted]'), 'vault pointer redacted in audit');
  perform tests.eq(public.sync_get_refresh_token(current_setting('t.conn')::uuid), 'refresh-token-value-123', 'service role can read token');
end $$;

-- Rows as produced by core/src/sync.ts eventToRow()
create or replace function tests.rows(p_pax int, p_etag text, p_cancel_assigned boolean, p_include_note boolean) returns jsonb language sql as $$
  select jsonb_agg(x) filter (where x is not null) from (values
    (jsonb_build_object('google_event_id', 'evt_unfilled', 'etag', p_etag, 'source_status', 'confirmed',
      'start_at', '2026-10-21T19:00:00Z', 'end_at', '2026-10-21T20:00:00Z', 'is_reservation', true, 'trip_ref', 'TRP-90001',
      'destination_code', 'NYC', 'passengers', p_pax, 'checked_bags', 0, 'assignment', 'UNFILLED', 'congestion', 'YES',
      'parser_version', 1, 'parsed', jsonb_build_object('passengers', p_pax), 'review_flags', '[]'::jsonb)),
    (case when p_cancel_assigned then jsonb_build_object('google_event_id', 'evt_assigned', 'etag', '"9"', 'source_status', 'cancelled')
     else jsonb_build_object('google_event_id', 'evt_assigned', 'etag', '"1"', 'source_status', 'confirmed',
      'start_at', '2026-10-21T19:00:00Z', 'end_at', '2026-10-21T20:00:00Z', 'is_reservation', true, 'trip_ref', 'TRP-90002',
      'destination_code', 'JFK', 'passengers', 4, 'assignment', 'ASSIGNED', 'assigned_driver_id', current_setting('t.d'),
      'parser_version', 1, 'parsed', '{}'::jsonb) end),
    (case when p_include_note then jsonb_build_object('google_event_id', 'evt_note', 'etag', '"1"', 'source_status', 'confirmed',
      'start_at', '2026-10-21T14:00:00Z', 'end_at', '2026-10-21T15:00:00Z', 'is_reservation', false, 'assignment', 'NOT_A_RESERVATION',
      'parser_version', 1, 'parsed', '{}'::jsonb) end)
  ) v(x);
$$;

-- Run 1: initial import
select set_config('t.run1', (public.sync_begin(current_setting('t.admin')::uuid)->>'run_id'), false);
select tests.throws($$select public.sync_begin(current_setting('t.admin')::uuid)$$, 'SYNC_RUNNING', 'parallel sync refused');
update public.sync_runs set window_start = '2026-10-01', window_end = '2026-12-31' where id = current_setting('t.run1')::uuid;
select tests.eq(public.sync_apply(current_setting('t.run1')::uuid, tests.rows(1, '"1"', false, true))->>'inserted', '3', 'three events imported');
select public.sync_finish(current_setting('t.run1')::uuid, true);
do $$ begin
  perform tests.eq((select count(*) from public.reservations), 3::bigint, 'three rows');
  -- Criterion 16: the unfilled reservation is recognized
  perform tests.eq((select assignment::text from public.reservations where google_event_id = 'evt_unfilled'), 'UNFILLED', 'unfilled recognized');
  perform tests.eq((select assigned_driver_id from public.reservations where google_event_id = 'evt_assigned'), current_setting('t.d')::uuid, 'assignment linked to driver');
  perform tests.ok((select last_success_at is not null from public.calendar_connections), 'last success recorded');
end $$;

-- Run 2: Criterion 14 — repeating the sync does not duplicate anything
select set_config('t.run2', (public.sync_begin(current_setting('t.admin')::uuid)->>'run_id'), false);
update public.sync_runs set window_start = '2026-10-01', window_end = '2026-12-31' where id = current_setting('t.run2')::uuid;
do $$ declare v jsonb; begin
  v := public.sync_apply(current_setting('t.run2')::uuid, tests.rows(1, '"1"', false, true));
  perform tests.eq(v->>'inserted', '0', 'nothing inserted on repeat');
  perform tests.eq(v->>'unchanged', '3', 'all unchanged on repeat');
  perform tests.eq((select count(*) from public.reservations), 3::bigint, 'still three rows');
end $$;
select public.sync_finish(current_setting('t.run2')::uuid, true);

-- Admin correction (local only)
select tests.login(current_setting('t.admin')::uuid);
insert into public.reservation_corrections (reservation_id, congestion, duration_minutes, updated_by)
select id, 'NO', 75, auth.uid() from public.reservations where google_event_id = 'evt_unfilled';
select tests.logout();

-- Run 3: Criterion 15 — a modified event updates; a cancelled one and a deleted one are marked removed (kept for audit)
select set_config('t.run3', (public.sync_begin(current_setting('t.admin')::uuid)->>'run_id'), false);
update public.sync_runs set window_start = '2026-10-01', window_end = '2026-12-31' where id = current_setting('t.run3')::uuid;
do $$ declare v jsonb; begin
  v := public.sync_apply(current_setting('t.run3')::uuid, tests.rows(2, '"2"', true, false));
  perform tests.eq(v->>'updated', '1', 'modified event updated');
  perform tests.eq(v->>'removed', '2', 'cancelled + vanished events removed');
  perform tests.eq((select passengers from public.reservations where google_event_id = 'evt_unfilled'), 2, 'new passenger count');
  perform tests.ok((select removed_from_source from public.reservations where google_event_id = 'evt_assigned'), 'cancelled marked removed');
  perform tests.ok((select removed_from_source from public.reservations where google_event_id = 'evt_note'), 'deleted marked removed');
  perform tests.eq((select count(*) from public.reservations), 3::bigint, 'nothing hard-deleted');
  -- Imported data and local corrections stay separate
  perform tests.eq((select congestion::text from public.reservations where google_event_id = 'evt_unfilled'), 'YES', 'imported value kept');
  perform tests.eq((select congestion::text from public.reservations_effective where google_event_id = 'evt_unfilled'), 'NO', 'correction wins in effective view');
  perform tests.eq((select congestion_source from public.reservations_effective where google_event_id = 'evt_unfilled'), 'CORRECTED', 'source is shown');
  perform tests.eq((select corrected_duration_minutes from public.reservations_effective where google_event_id = 'evt_unfilled'), 75, 'duration correction');
end $$;
select public.sync_finish(current_setting('t.run3')::uuid, true);

-- An event that comes back after cancellation is restored
select set_config('t.run4', (public.sync_begin(current_setting('t.admin')::uuid)->>'run_id'), false);
update public.sync_runs set window_start = '2026-10-01', window_end = '2026-12-31' where id = current_setting('t.run4')::uuid;
select public.sync_apply(current_setting('t.run4')::uuid, tests.rows(2, '"2"', false, false));
do $$ begin
  perform tests.ok(not (select removed_from_source from public.reservations where google_event_id = 'evt_assigned'), 'reinstated event restored');
end $$;

-- Expired authorization is reported clearly and data stays available (marked stale)
select public.sync_finish(current_setting('t.run4')::uuid, false, 'Google authorization expired (invalid_grant)', true);
select tests.login(current_setting('t.admin')::uuid);
do $$ declare s jsonb := public.admin_sync_status(); begin
  perform tests.eq(s->'connection'->>'status', 'EXPIRED', 'expired status shown');
  perform tests.ok((s->>'stale')::boolean, 'stale flagged');
  perform tests.ok(s->'connection'->>'last_success_at' is not null, 'last successful sync still shown');
  perform tests.eq((select count(*) from public.reservations_effective), 3::bigint, 'previous data still visible');
end $$;
select tests.logout();

-- Reconnecting keeps the same connection and every imported reservation
do $$ begin
  perform tests.eq(public.store_calendar_connection(current_setting('t.admin')::uuid, 'support@example.test', '{}', 'new-refresh-token-456'),
    current_setting('t.conn')::uuid, 'same connection row reused');
  perform tests.eq((select count(*) from public.reservations), 3::bigint, 'reservations survive reconnection');
  perform tests.eq(public.sync_get_refresh_token(current_setting('t.conn')::uuid), 'new-refresh-token-456', 'token replaced');
  perform tests.eq((select count(*) from vault.secrets), 1::bigint, 'no orphaned secrets');
end $$;

-- Drivers never see reservations, even through the effective view
select tests.login(current_setting('t.d')::uuid);
do $$ begin
  perform tests.eq((select count(*) from public.reservations_effective), 0::bigint, 'driver sees no reservations via view');
  perform tests.eq(public.admin_sync_status(), null::jsonb, 'driver gets no sync status');
end $$;
select tests.throws($$select public.admin_set_calendar('x', 'y')$$, 'FORBIDDEN', 'driver cannot choose calendar');
select tests.logout();

-- Disconnect forgets the token but keeps data
select tests.login(current_setting('t.admin')::uuid);
select public.admin_disconnect_calendar();
select tests.logout();
do $$ begin
  perform tests.eq((select count(*) from vault.secrets), 0::bigint, 'secret deleted on disconnect');
  perform tests.eq((select count(*) from public.reservations), 3::bigint, 'data kept on disconnect');
end $$;
