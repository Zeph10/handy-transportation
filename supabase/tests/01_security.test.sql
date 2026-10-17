-- Authorization tests: acceptance criteria 1, 2, 5, 11, 23 and the "specifically prevent" list.

-- Setup (as the database owner)
select set_config('t.admin', tests.new_user('admin@t.test')::text, false);
select set_config('t.a', tests.new_user('a@t.test')::text, false);
select set_config('t.b', tests.new_user('b@t.test')::text, false);
select set_config('t.p', tests.new_user('pending@t.test')::text, false);
select public.bootstrap_admin('admin@t.test');
update public.driver_profiles set status = 'APPROVED' where user_id in (current_setting('t.a')::uuid, current_setting('t.b')::uuid);
insert into public.driver_destination_defaults (driver_id, destination_id, min_rate_cents)
  select p, d.id, d.preset_payout_cents from public.destinations d, unnest(array[current_setting('t.a')::uuid, current_setting('t.b')::uuid]) p;

-- Criterion 1: new sign-ups are pending drivers
do $$ begin
  perform tests.eq((select status::text from public.driver_profiles where user_id = current_setting('t.p')::uuid), 'PENDING_APPROVAL', 'new user is pending');
  perform tests.eq((select role::text from public.user_roles where user_id = current_setting('t.p')::uuid), 'DRIVER', 'new user is a driver');
  perform tests.eq((select role::text from public.user_roles where user_id = current_setting('t.admin')::uuid), 'ADMIN', 'bootstrap admin');
end $$;

-- Driver B creates a vehicle and a block (via RPC)
select tests.login(current_setting('t.b')::uuid);
select set_config('t.bv', public.save_vehicle('{"name":"B car","vehicle_type":"SEDAN","max_passengers":3,"max_luggage":2}'::jsonb)::text, false);
select set_config('t.bblock', (public.save_block(jsonb_build_object(
  'start_at', now() + interval '3 days', 'end_at', now() + interval '3 days 4 hours', 'status', 'AVAILABLE',
  'vehicle_id', current_setting('t.bv'),
  'destinations', jsonb_build_array(jsonb_build_object('destination_id', (select id from public.destinations where code = 'EWR'), 'min_rate_cents', null)))
)->>'block_id'), false);
select tests.logout();

-- Criterion 2: a pending user can see only their own profile and nothing else
select tests.login(current_setting('t.p')::uuid);
do $$ begin
  perform tests.eq((select count(*) from public.driver_profiles), 1::bigint, 'pending user sees only own profile');
  perform tests.eq((select count(*) from public.destinations), 0::bigint, 'pending user sees no destinations');
  perform tests.eq((select count(*) from public.vehicles), 0::bigint, 'pending user sees no vehicles');
  perform tests.eq((select count(*) from public.availability_blocks), 0::bigint, 'pending user sees no availability');
  perform tests.eq(public.get_public_settings(), null::jsonb, 'pending user gets no settings');
end $$;
select tests.throws($$select public.save_vehicle('{"name":"x","vehicle_type":"SEDAN","max_passengers":3}'::jsonb)$$, 'FORBIDDEN', 'pending cannot add vehicle');
select tests.throws($$select public.save_block('{}'::jsonb)$$, 'FORBIDDEN', 'pending cannot save availability');
select tests.logout();

-- Criterion 5 / horizontal escalation: driver A cannot see or touch driver B's data
select tests.login(current_setting('t.a')::uuid);
do $$ begin
  perform tests.eq((select count(*) from public.driver_profiles), 1::bigint, 'A sees only own profile');
  perform tests.eq((select count(*) from public.vehicles where driver_id = current_setting('t.b')::uuid), 0::bigint, 'A cannot see B vehicles');
  perform tests.eq((select count(*) from public.availability_blocks where id = current_setting('t.bblock')::uuid), 0::bigint, 'A cannot see B block by id');
  perform tests.eq((select count(*) from public.availability_block_destinations), 0::bigint, 'A cannot see B block destinations');
  perform tests.eq((select count(*) from public.driver_destination_defaults where driver_id = current_setting('t.b')::uuid), 0::bigint, 'A cannot see B rates');
  perform tests.ok((select count(*) from public.destinations) >= 5, 'approved driver sees destinations');
end $$;
-- Editing B's block by id fails as if it did not exist
select tests.throws(format($$select public.save_block(jsonb_build_object('start_at', now() + interval '3 days', 'end_at', now() + interval '3 days 1 hour', 'status', 'UNAVAILABLE'), %L::uuid, 1)$$,
  current_setting('t.bblock')), 'NOT_FOUND', 'A cannot edit B block');
select tests.throws(format($$select public.delete_block(%L::uuid, 1)$$, current_setting('t.bblock')), 'NOT_FOUND', 'A cannot delete B block');
-- Using B's vehicle in A's block is rejected
select tests.throws(format($$select public.save_block(jsonb_build_object('start_at', now() + interval '5 days', 'end_at', now() + interval '5 days 1 hour',
  'status', 'AVAILABLE', 'vehicle_id', %L, 'destinations', jsonb_build_array(jsonb_build_object('destination_id', (select id from public.destinations where code='EWR')))))$$,
  current_setting('t.bv')), 'VALIDATION', 'A cannot use B vehicle');
-- A driver_id smuggled into the payload is ignored: the block belongs to A
select set_config('t.av', public.save_vehicle('{"name":"A car","vehicle_type":"SUV","max_passengers":6}'::jsonb)::text, false);
select set_config('t.ablock', (public.save_block(jsonb_build_object('driver_id', current_setting('t.b'),
  'start_at', now() + interval '3 days', 'end_at', now() + interval '3 days 4 hours', 'status', 'AVAILABLE', 'vehicle_id', current_setting('t.av'),
  'destinations', jsonb_build_array(jsonb_build_object('destination_id', (select id from public.destinations where code = 'JFK')))))->>'block_id'), false);
-- Direct table writes are not permitted for clients
select tests.throws($$insert into public.availability_blocks (driver_id, start_at, end_at) values (auth.uid(), now(), now() + interval '1 hour')$$, '42501', 'no direct insert');
select tests.throws($$update public.availability_blocks set notes = 'x'$$, '42501', 'no direct update');
select tests.throws($$delete from public.vehicles$$, '42501', 'no direct delete');
select tests.throws($$update public.driver_profiles set status = 'APPROVED'$$, '42501', 'cannot change own status');
select tests.throws($$update public.user_roles set role = 'ADMIN'$$, '42501', 'cannot change own role');
select tests.throws($$insert into public.user_roles (user_id, role) values (auth.uid(), 'ADMIN')$$, '42501', 'cannot grant self admin');
-- Settings/presets: RLS filters every row, so an update silently changes nothing.
update public.app_settings set short_notice_window_hours = 0;
update public.destinations set preset_payout_cents = 1;
select tests.throws($$insert into public.destinations (code, name, preset_payout_cents) values ('HACK', 'x', 1)$$, '42501', 'cannot add destinations');
select tests.throws($$select public.bootstrap_admin('a@t.test')$$, '42501', 'cannot call bootstrap_admin');
select tests.throws(format($$select public.set_driver_status(%L::uuid, 'APPROVED')$$, current_setting('t.p')), 'FORBIDDEN', 'driver cannot approve');
select tests.throws(format($$select public.admin_save_block(%L::uuid, '{}'::jsonb)$$, current_setting('t.b')), 'FORBIDDEN', 'driver cannot use admin edit');
select tests.throws($$select public.write_audit('x','x',null,null,null,null)$$, '42501', 'cannot write audit directly');
select tests.throws($$select public._insert_block(auth.uid(), '{}'::jsonb, 'DRIVER')$$, '42501', 'cannot call internal helpers');
-- Criterion 23: no reservation or admin data reaches drivers
do $$ begin
  perform tests.eq((select count(*) from public.reservations), 0::bigint, 'driver sees no reservations');
  perform tests.eq((select count(*) from public.audit_log), 0::bigint, 'driver sees no audit log');
  perform tests.eq((select count(*) from public.app_settings), 0::bigint, 'driver cannot read raw settings');
  perform tests.eq((select count(*) from public.admin_driver_notes), 0::bigint, 'driver sees no admin notes');
  perform tests.eq((select count(*) from public.parsing_rules), 0::bigint, 'driver sees no parsing rules');
  perform tests.eq((select count(*) from public.sync_runs), 0::bigint, 'driver sees no sync runs');
  perform tests.eq((select count(*) from public.admin_driver_directory()), 0::bigint, 'driver gets no directory');
  perform tests.ok(public.get_public_settings() ? 'congestion_surcharge_cents', 'driver gets safe settings');
  perform tests.ok(not (public.get_public_settings() ? 'travel_to_pickup_minutes'), 'safe settings omit internals');
end $$;
select tests.throws($$select vault_secret_id from public.calendar_connections$$, '42501', 'vault pointer never selectable');
select tests.logout();

do $$ begin
  perform tests.eq((select driver_id from public.availability_blocks where id = current_setting('t.ablock')::uuid), current_setting('t.a')::uuid, 'smuggled driver_id ignored');
  perform tests.eq((select short_notice_window_hours from public.app_settings), 24, 'driver could not change settings');
  perform tests.eq((select preset_payout_cents from public.destinations where code = 'JFK'), 21000, 'driver could not change presets');
end $$;

-- Anonymous visitors see nothing at all
select tests.login(null);
select tests.throws($$select count(*) from public.driver_profiles$$, '42501', 'anon has no table access');
select tests.throws($$select public.get_public_settings()$$, '42501', 'anon cannot call RPCs');
select tests.logout();

-- Criterion 11: admin sees every driver and every block
select tests.login(current_setting('t.admin')::uuid);
do $$ begin
  perform tests.eq((select count(*) from public.driver_profiles), 4::bigint, 'admin sees all profiles');
  perform tests.eq((select count(*) from public.availability_blocks where deleted_at is null), 2::bigint, 'admin sees all blocks');
  perform tests.eq((select count(*) from public.app_settings), 1::bigint, 'admin reads settings');
  perform tests.ok((select count(*) from public.audit_log) > 0, 'admin reads audit log');
end $$;
-- Admin can approve; approval seeds rate defaults from presets
select public.set_driver_status(current_setting('t.p')::uuid, 'APPROVED', 'Welcome');
do $$ begin
  perform tests.eq((select status::text from public.driver_profiles where user_id = current_setting('t.p')::uuid), 'APPROVED', 'approved');
  perform tests.eq((select min_rate_cents from public.driver_destination_defaults d join public.destinations x on x.id = d.destination_id
                    where d.driver_id = current_setting('t.p')::uuid and x.code = 'JFK'), 21000, 'JFK default seeded from preset');
  perform tests.ok(exists (select 1 from public.audit_log where action = 'DRIVER_STATUS_CHANGED' and affected_driver_id = current_setting('t.p')::uuid), 'approval audited');
end $$;
select tests.throws(format($$select public.set_driver_status(%L::uuid, 'SUSPENDED')$$, current_setting('t.admin')), 'VALIDATION', 'admin cannot suspend self');
-- Admin settings edits are audited
update public.app_settings set congestion_surcharge_cents = 1000 where id = 1;
do $$ begin
  perform tests.ok(exists (select 1 from public.audit_log where entity_table = 'app_settings' and (after->>'congestion_surcharge_cents')::int = 1000), 'settings change audited');
end $$;
select tests.logout();

-- Suspended drivers lose access immediately
select tests.login(current_setting('t.admin')::uuid);
select public.set_driver_status(current_setting('t.b')::uuid, 'SUSPENDED', 'Test');
select tests.logout();
select tests.login(current_setting('t.b')::uuid);
do $$ begin
  perform tests.eq((select count(*) from public.availability_blocks), 0::bigint, 'suspended driver sees no availability');
end $$;
select tests.throws($$select public.save_vehicle('{"name":"x","vehicle_type":"SEDAN","max_passengers":3}'::jsonb)$$, 'FORBIDDEN', 'suspended cannot write');
select tests.logout();
