-- Availability behaviour: criteria 3, 6, 7, 8, 9, 10, 12 and short-notice / concurrency rules.

select set_config('t.admin', tests.new_user('admin2@t.test')::text, false);
select set_config('t.d', tests.new_user('d@t.test')::text, false);
select public.bootstrap_admin('admin2@t.test');
update public.driver_profiles set status = 'APPROVED' where user_id = current_setting('t.d')::uuid;
update public.app_settings set short_notice_window_hours = 24;
select set_config('t.ewr', (select id::text from public.destinations where code = 'EWR'), false);
select set_config('t.jfk', (select id::text from public.destinations where code = 'JFK'), false);
select set_config('t.nyc', (select id::text from public.destinations where code = 'NYC'), false);

-- Helper to build block payloads relative to now (as the owner, before switching roles)
create or replace function tests.blk(p_start interval, p_end interval, p_status text, p_vehicle text, p_dests jsonb)
returns jsonb language sql as $$
  select jsonb_build_object('start_at', date_trunc('hour', now()) + p_start, 'end_at', date_trunc('hour', now()) + p_end,
    'status', p_status, 'vehicle_id', p_vehicle, 'destinations', p_dests);
$$;
grant execute on function tests.blk(interval, interval, text, text, jsonb) to authenticated;

select tests.login(current_setting('t.d')::uuid);
select set_config('t.suv', public.save_vehicle('{"name":"SUV","vehicle_type":"SUV","max_passengers":6,"max_luggage":6}'::jsonb)::text, false);
select set_config('t.sedan', public.save_vehicle('{"name":"Sedan","vehicle_type":"SEDAN","max_passengers":3,"max_luggage":3}'::jsonb)::text, false);

-- Vehicle validation (criterion: prevent invalid capacity)
select tests.throws($$select public.save_vehicle('{"name":"Bad","vehicle_type":"SEDAN","max_passengers":0}'::jsonb)$$, 'VALIDATION', 'zero seats rejected');
select tests.throws($$select public.save_vehicle('{"name":"Bad","vehicle_type":"SEDAN","max_passengers":70}'::jsonb)$$, 'VALIDATION', 'too many seats rejected');
select tests.throws($$select public.save_vehicle('{"name":"Bad","vehicle_type":"BOAT","max_passengers":3}'::jsonb)$$, 'VALIDATION', 'bad type rejected');
do $$ begin
  perform tests.eq((select count(*) from public.vehicles where is_default), 1::bigint, 'exactly one default vehicle');
end $$;

-- Criteria 6 + 10: several blocks on one day, each with its own vehicle, destinations and rates
select set_config('t.b1', (public.save_block(tests.blk('3 days 6 hours', '3 days 11 hours', 'AVAILABLE', current_setting('t.suv'),
  jsonb_build_array(jsonb_build_object('destination_id', current_setting('t.ewr'), 'min_rate_cents', 12000),
                    jsonb_build_object('destination_id', current_setting('t.jfk'), 'min_rate_cents', null))))->>'block_id'), false);
select public.save_block(tests.blk('3 days 11 hours', '3 days 15 hours', 'UNAVAILABLE', null, '[]'::jsonb));
select set_config('t.b3', (public.save_block(tests.blk('3 days 15 hours', '3 days 22 hours', 'AVAILABLE', current_setting('t.sedan'),
  jsonb_build_array(jsonb_build_object('destination_id', current_setting('t.nyc'), 'min_rate_cents', 17500))))->>'block_id'), false);
do $$ begin
  perform tests.eq((select count(*) from public.availability_blocks where deleted_at is null), 3::bigint, 'three blocks saved');
  perform tests.eq((select min_rate_cents from public.availability_block_destinations where block_id = current_setting('t.b1')::uuid
                    and destination_id = current_setting('t.ewr')::uuid), 12000, 'per-block rate stored');
  perform tests.eq((select min_rate_cents from public.availability_block_destinations where block_id = current_setting('t.b1')::uuid
                    and destination_id = current_setting('t.jfk')::uuid), null::integer, 'inherit marker stored as null');
  perform tests.eq((select vehicle_id::text from public.availability_blocks where id = current_setting('t.b3')::uuid), current_setting('t.sedan'), 'per-block vehicle');
end $$;

-- Contradictory records are impossible
select tests.throws($$select public.save_block(tests.blk('3 days 10 hours', '3 days 12 hours', 'AVAILABLE', current_setting('t.suv'),
  jsonb_build_array(jsonb_build_object('destination_id', current_setting('t.ewr')))))$$, 'OVERLAP', 'overlapping block rejected');
select tests.throws($$select public.save_block(tests.blk('4 days 10 hours', '4 days 9 hours', 'AVAILABLE', current_setting('t.suv'),
  jsonb_build_array(jsonb_build_object('destination_id', current_setting('t.ewr')))))$$, 'VALIDATION', 'end before start rejected');
select tests.throws($$select public.save_block(tests.blk('4 days 1 hour', '4 days 2 hours', 'AVAILABLE', current_setting('t.suv'), '[]'::jsonb))$$, 'VALIDATION', 'available block needs a destination');
select tests.throws($$select public.save_block(tests.blk('4 days 1 hour', '4 days 2 hours', 'AVAILABLE', current_setting('t.suv'),
  jsonb_build_array(jsonb_build_object('destination_id', current_setting('t.ewr'), 'min_rate_cents', -5))))$$, 'VALIDATION', 'negative rate rejected');
select tests.throws($$select public.save_block(tests.blk('4 days 1 hour', '4 days 2 hours', 'AVAILABLE', null,
  jsonb_build_array(jsonb_build_object('destination_id', current_setting('t.ewr')))))$$, 'VALIDATION', 'available block needs a vehicle');

-- Criterion 7: an overnight block is ONE record spanning midnight
select set_config('t.night', (public.save_block(jsonb_build_object(
  'start_at', ((current_date + 6) + time '20:00') at time zone 'America/New_York',
  'end_at', ((current_date + 7) + time '04:00') at time zone 'America/New_York',
  'status', 'AVAILABLE', 'vehicle_id', current_setting('t.suv'),
  'destinations', jsonb_build_array(jsonb_build_object('destination_id', current_setting('t.ewr')))))->>'block_id'), false);
select public.delete_block(current_setting('t.night')::uuid, 1);
do $$ begin
  perform tests.ok((select deleted_at is not null from public.availability_blocks where id = current_setting('t.night')::uuid), 'overnight block deleted as one unit');
  perform tests.eq((select count(*) from public.availability_blocks where deleted_at is null and start_at >= now() + interval '6 days'), 0::bigint, 'no orphaned half remains');
end $$;

-- Concurrency: a stale version cannot overwrite a newer edit
select tests.eq(public.save_block(tests.blk('3 days 5 hours', '3 days 11 hours', 'AVAILABLE', current_setting('t.suv'),
  jsonb_build_array(jsonb_build_object('destination_id', current_setting('t.ewr')))), current_setting('t.b1')::uuid, 1)->>'result', 'SAVED', 'edit with current version saves');
select tests.throws(format($$select public.save_block(tests.blk('3 days 4 hours', '3 days 11 hours', 'AVAILABLE', current_setting('t.suv'),
  jsonb_build_array(jsonb_build_object('destination_id', current_setting('t.ewr')))), %L::uuid, 1)$$, current_setting('t.b1')), 'CONFLICT', 'stale version rejected');
select tests.throws(format($$select public.save_block(tests.blk('3 days 5 hours', '3 days 12 hours', 'AVAILABLE', current_setting('t.suv'),
  jsonb_build_array(jsonb_build_object('destination_id', current_setting('t.ewr')))), %L::uuid, 2)$$, current_setting('t.b1')), 'OVERLAP', 'edit into a neighbour rejected');

-- Short-notice window (24 h): reductions need approval and never erase the confirmed record
select set_config('t.soon', (public.save_block(tests.blk('2 hours', '8 hours', 'AVAILABLE', current_setting('t.suv'),
  jsonb_build_array(jsonb_build_object('destination_id', current_setting('t.ewr')), jsonb_build_object('destination_id', current_setting('t.jfk')))))->>'block_id'), false);
-- Extending (an addition) inside the window applies immediately
select tests.eq(public.save_block(tests.blk('2 hours', '9 hours', 'AVAILABLE', current_setting('t.suv'),
  jsonb_build_array(jsonb_build_object('destination_id', current_setting('t.ewr')), jsonb_build_object('destination_id', current_setting('t.jfk')))),
  current_setting('t.soon')::uuid, 1)->>'result', 'SAVED', 'addition inside window applies');
-- Shortening inside the window becomes a change request
select tests.eq(public.save_block(tests.blk('2 hours', '5 hours', 'AVAILABLE', current_setting('t.suv'),
  jsonb_build_array(jsonb_build_object('destination_id', current_setting('t.ewr')), jsonb_build_object('destination_id', current_setting('t.jfk')))),
  current_setting('t.soon')::uuid, 2)->>'result', 'PENDING_APPROVAL', 'shortening needs approval');
do $$ begin
  perform tests.eq((select end_at from public.availability_blocks where id = current_setting('t.soon')::uuid), date_trunc('hour', now()) + interval '9 hours', 'confirmed block untouched while pending');
end $$;
-- A second pending change to the same block is refused (no silent stacking)
select tests.throws(format($$select public.delete_block(%L::uuid, 2)$$, current_setting('t.soon')), 'CONFLICT', 'one pending change per block');
select tests.logout();

-- Dropping a destination, raising a minimum or switching to a smaller vehicle are reductions too
do $$ declare v_reduce boolean; begin
  v_reduce := public._block_change_reduces(current_setting('t.d')::uuid, public._block_snapshot(current_setting('t.soon')::uuid),
    tests.blk('2 hours', '9 hours', 'AVAILABLE', current_setting('t.suv'), jsonb_build_array(jsonb_build_object('destination_id', current_setting('t.ewr')))));
  perform tests.ok(v_reduce, 'dropping JFK is a reduction');
  v_reduce := public._block_change_reduces(current_setting('t.d')::uuid, public._block_snapshot(current_setting('t.soon')::uuid),
    tests.blk('2 hours', '9 hours', 'AVAILABLE', current_setting('t.sedan'),
      jsonb_build_array(jsonb_build_object('destination_id', current_setting('t.ewr')), jsonb_build_object('destination_id', current_setting('t.jfk')))));
  perform tests.ok(v_reduce, 'smaller vehicle is a reduction');
  v_reduce := public._block_change_reduces(current_setting('t.d')::uuid, public._block_snapshot(current_setting('t.soon')::uuid),
    tests.blk('2 hours', '9 hours', 'AVAILABLE', current_setting('t.suv'),
      jsonb_build_array(jsonb_build_object('destination_id', current_setting('t.ewr'), 'min_rate_cents', 50000), jsonb_build_object('destination_id', current_setting('t.jfk')))));
  perform tests.ok(v_reduce, 'raising a minimum is a reduction');
  v_reduce := public._block_change_reduces(current_setting('t.d')::uuid, public._block_snapshot(current_setting('t.soon')::uuid),
    tests.blk('2 hours', '9 hours', 'AVAILABLE', current_setting('t.suv'),
      jsonb_build_array(jsonb_build_object('destination_id', current_setting('t.ewr'), 'min_rate_cents', 5000), jsonb_build_object('destination_id', current_setting('t.jfk')),
                        jsonb_build_object('destination_id', current_setting('t.nyc')))));
  perform tests.ok(not v_reduce, 'adding a destination and lowering a minimum is not a reduction');
end $$;

-- Admin approves the pending change: it is applied and audited
select tests.login(current_setting('t.admin')::uuid);
select public.decide_change_request((select id from public.change_requests where target_id = current_setting('t.soon')::uuid and status = 'PENDING'), true, 'OK');
do $$ begin
  perform tests.eq((select end_at from public.availability_blocks where id = current_setting('t.soon')::uuid), date_trunc('hour', now()) + interval '5 hours', 'approved change applied');
  perform tests.eq((select status::text from public.change_requests where target_id = current_setting('t.soon')::uuid), 'APPROVED', 'request marked approved');
end $$;

-- Criterion 12: admin edits are logged with who, which driver, when, before and after
select public.admin_save_block(current_setting('t.d')::uuid, tests.blk('3 days 15 hours', '3 days 20 hours', 'AVAILABLE', current_setting('t.sedan'),
  jsonb_build_array(jsonb_build_object('destination_id', current_setting('t.nyc'), 'min_rate_cents', 17500))),
  current_setting('t.b3')::uuid, 1, 'Driver called in: leaving early');
do $$ declare a public.audit_log; begin
  select * into a from public.audit_log where entity_id = current_setting('t.b3') and action = 'BLOCK_UPDATED' order by id desc limit 1;
  perform tests.eq(a.actor_id, current_setting('t.admin')::uuid, 'audit: who');
  perform tests.eq(a.actor_role, 'ADMIN', 'audit: role');
  perform tests.eq(a.affected_driver_id, current_setting('t.d')::uuid, 'audit: which driver');
  perform tests.ok(a.created_at is not null, 'audit: when');
  perform tests.eq((a.before->>'end_at')::timestamptz, date_trunc('hour', now()) + interval '3 days 22 hours', 'audit: previous value');
  perform tests.eq((a.after->>'end_at')::timestamptz, date_trunc('hour', now()) + interval '3 days 20 hours', 'audit: new value');
  perform tests.eq(a.reason, 'Driver called in: leaving early', 'audit: reason');
  perform tests.eq(jsonb_array_length(a.after->'destinations'), 1, 'audit snapshot includes destinations');
end $$;
-- Admin marks the driver unavailable without touching their own entries
select set_config('t.au', public.admin_mark_unavailable(current_setting('t.d')::uuid, now() + interval '3 days 6 hours', now() + interval '3 days 8 hours', 'Vehicle in shop')::text, false);
select tests.logout();

-- The driver sees the admin's changes in their own interface
select tests.login(current_setting('t.d')::uuid);
do $$ begin
  perform tests.ok(exists (select 1 from public.my_admin_changes() where action = 'BLOCK_UPDATED'), 'driver sees admin edit');
  perform tests.ok(exists (select 1 from public.my_admin_changes() where entity_table = 'admin_unavailability'), 'driver sees admin unavailability');
  perform tests.eq((select count(*) from public.admin_unavailability), 1::bigint, 'driver can read their admin-unavailability period');
  perform tests.eq((select count(*) from public.availability_blocks where id = current_setting('t.b1')::uuid and deleted_at is null), 1::bigint, 'driver block intact under admin unavailability');
end $$;

-- Criterion 8: weekly recurrence, effective dates, and "this day only" exceptions
select set_config('t.rule', (public.save_rule(jsonb_build_object(
  'weekdays', jsonb_build_array(1,2,3,4,5), 'local_start', '06:00', 'local_end', '14:00', 'end_day_offset', 0,
  'effective_from', current_date + 10, 'status', 'AVAILABLE', 'vehicle_id', current_setting('t.suv'),
  'destinations', jsonb_build_array(jsonb_build_object('destination_id', current_setting('t.ewr')))))->>'rule_id'), false);
select tests.throws($$select public.save_rule(jsonb_build_object('weekdays', jsonb_build_array(1), 'local_start', '14:00', 'local_end', '06:00',
  'end_day_offset', 0, 'effective_from', current_date, 'status', 'AVAILABLE', 'vehicle_id', current_setting('t.suv'),
  'destinations', jsonb_build_array(jsonb_build_object('destination_id', current_setting('t.ewr')))))$$, 'VALIDATION', 'end before start on same day rejected');
-- A rule entirely in the future is edited in place
select tests.eq(public.save_rule(jsonb_build_object('weekdays', jsonb_build_array(1,3,5), 'local_start', '07:00', 'local_end', '15:00',
  'end_day_offset', 0, 'effective_from', current_date + 10, 'status', 'AVAILABLE', 'vehicle_id', current_setting('t.suv'),
  'destinations', jsonb_build_array(jsonb_build_object('destination_id', current_setting('t.ewr')))), current_setting('t.rule')::uuid, 1)->>'rule_id',
  current_setting('t.rule'), 'future rule edited in place');
-- Skip one occurrence (outside window → immediate)
select public.skip_occurrence(current_setting('t.rule')::uuid,
  (select d::date from generate_series(current_date + 10, current_date + 20, interval '1 day') d where extract(isodow from d) = 3 limit 1));
do $$ begin
  perform tests.eq((select count(*) from public.rule_exceptions where rule_id = current_setting('t.rule')::uuid), 1::bigint, 'exception stored');
  perform tests.eq((select count(*) from public.availability_rules where driver_id = current_setting('t.d')::uuid and deleted_at is null), 1::bigint,
    'no rows generated per occurrence');
end $$;
select tests.throws(format($$select public.skip_occurrence(%L::uuid, current_date + 10 + ((9 - extract(isodow from current_date + 10)::int) %% 7))$$, current_setting('t.rule')),
  'VALIDATION', 'skipping a day the rule does not run is rejected');
select tests.logout();

-- A rule that started in the past is split: the past keeps the old schedule
select tests.logout();
update public.availability_rules set effective_from = current_date - 30 where id = current_setting('t.rule')::uuid;
select tests.login(current_setting('t.d')::uuid);
select set_config('t.split', public.save_rule(jsonb_build_object('weekdays', jsonb_build_array(1,2,3,4,5), 'local_start', '08:00', 'local_end', '16:00',
  'end_day_offset', 0, 'effective_from', current_date - 30, 'status', 'AVAILABLE', 'vehicle_id', current_setting('t.suv'),
  'destinations', jsonb_build_array(jsonb_build_object('destination_id', current_setting('t.ewr')))), current_setting('t.rule')::uuid,
  (select version from public.availability_rules where id = current_setting('t.rule')::uuid))::text, false);
do $$ declare v jsonb := current_setting('t.split')::jsonb; begin
  perform tests.ok((v->>'rule_id') <> current_setting('t.rule'), 'a new series was created');
  perform tests.eq((select effective_until from public.availability_rules where id = current_setting('t.rule')::uuid), (v->>'kept_until')::date, 'old series ends before cutoff');
  perform tests.eq((select effective_from from public.availability_rules where id = (v->>'rule_id')::uuid), (v->>'effective_from')::date, 'new series starts at cutoff');
  perform tests.ok((v->>'effective_from')::date > current_date, 'cutoff is after the short-notice window');
  perform tests.eq((select count(*) from public.rule_exceptions where rule_id = (v->>'rule_id')::uuid), 1::bigint, 'future exceptions moved to new series');
end $$;

-- Criterion 9: copy availability to several dates in one batch; overlaps are skipped, not duplicated
select tests.eq((public.save_blocks_batch(jsonb_build_array(
  tests.blk('10 days 6 hours', '10 days 10 hours', 'AVAILABLE', current_setting('t.suv'), jsonb_build_array(jsonb_build_object('destination_id', current_setting('t.ewr')))),
  tests.blk('11 days 6 hours', '11 days 10 hours', 'AVAILABLE', current_setting('t.suv'), jsonb_build_array(jsonb_build_object('destination_id', current_setting('t.ewr')))),
  tests.blk('3 days 6 hours', '3 days 7 hours', 'AVAILABLE', current_setting('t.suv'), jsonb_build_array(jsonb_build_object('destination_id', current_setting('t.ewr'))))
), 'COPY', true))->>'skipped', '1', 'overlapping copy skipped');
do $$ begin
  perform tests.eq((select count(*) from public.availability_blocks where origin = 'COPY' and deleted_at is null), 2::bigint, 'two copies created');
end $$;

-- Time off inside the window needs approval; further out applies immediately
select tests.eq(public.save_time_off(current_date, current_date, 'sick')->>'result', 'PENDING_APPROVAL', 'same-day time off needs approval');
select tests.eq(public.save_time_off(current_date + 30, current_date + 35, 'vacation')->>'result', 'SAVED', 'future time off saved');
select tests.throws($$select public.save_time_off(current_date + 5, current_date + 1)$$, 'VALIDATION', 'backwards time off rejected');

-- Vehicles in use cannot be archived (history stays intact)
select tests.throws(format($$select public.archive_vehicle(%L::uuid, (select version from public.vehicles where id = %L::uuid))$$,
  current_setting('t.suv'), current_setting('t.suv')), 'VALIDATION', 'in-use vehicle cannot be archived');

-- Profile: drivers can edit their own details but nothing else
select tests.eq((public.update_my_profile('Dana Test', '555-010-0000', 'Prefers mornings',
  (select version from public.driver_profiles where user_id = auth.uid()))).full_name, 'Dana Test', 'profile updated');
select tests.throws($$select public.update_my_profile('Dana', 'not a phone!', null, (select version from public.driver_profiles where user_id = auth.uid()))$$, 'VALIDATION', 'bad phone rejected');
select tests.throws($$select public.update_my_profile('Dana', null, null, 1)$$, 'CONFLICT', 'stale profile version rejected');
do $$ begin
  perform tests.eq((select status::text from public.driver_profiles where user_id = auth.uid()), 'APPROVED', 'status unchanged by profile edit');
end $$;

-- Usual destinations and minimums (audit snapshot is a list of rows)
select public.save_destination_defaults(jsonb_build_array(
  jsonb_build_object('destination_id', current_setting('t.jfk'), 'accepted', true, 'min_rate_cents', 22500),
  jsonb_build_object('destination_id', current_setting('t.ewr'), 'accepted', false, 'min_rate_cents', 11000)));
do $$ begin
  perform tests.eq((select min_rate_cents from public.driver_destination_defaults where destination_id = current_setting('t.jfk')::uuid), 22500, 'JFK minimum saved');
  perform tests.eq((select accepted from public.driver_destination_defaults where destination_id = current_setting('t.ewr')::uuid), false, 'EWR deselected');
end $$;
select tests.throws($$select public.save_destination_defaults(jsonb_build_array(jsonb_build_object('destination_id', current_setting('t.jfk'), 'min_rate_cents', -1)))$$, 'VALIDATION', 'negative default rejected');

-- Criterion 3: data persists (visible to a fresh read in the same session)
do $$ begin
  perform tests.ok((select count(*) from public.availability_blocks where deleted_at is null) >= 5, 'blocks persisted');
end $$;
select tests.logout();
