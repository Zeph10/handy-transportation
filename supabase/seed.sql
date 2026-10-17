-- DEVELOPMENT SEED DATA — applied only by `supabase db reset` on a LOCAL stack.
-- `supabase db push` (production) never runs this file.
--
-- Safety: every demo user uses the reserved .test domain and a "DEMO" name, and
-- the script refuses to run if app_settings.environment = 'production'.
do $$
begin
  if exists (select 1 from public.app_settings where environment = 'production') then
    raise exception 'Refusing to load demo data into a production database';
  end if;
end $$;

-- Demo accounts (log in locally through the magic-link inbox at http://localhost:54324).
insert into auth.users (id, email)
values
  ('00000000-0000-4000-8000-00000000a001', 'admin@demo.handy.test'),
  ('00000000-0000-4000-8000-00000000d001', 'dana@demo.handy.test'),
  ('00000000-0000-4000-8000-00000000d002', 'eli@demo.handy.test'),
  ('00000000-0000-4000-8000-00000000d003', 'pending@demo.handy.test')
on conflict (id) do nothing;

select public.bootstrap_admin('admin@demo.handy.test');

update public.driver_profiles set full_name = 'DEMO Admin' where user_id = '00000000-0000-4000-8000-00000000a001';
update public.driver_profiles set full_name = 'DEMO Dana Driver', status = 'APPROVED', phone = '555-0100'
 where user_id = '00000000-0000-4000-8000-00000000d001';
update public.driver_profiles set full_name = 'DEMO Eli Example', status = 'APPROVED'
 where user_id = '00000000-0000-4000-8000-00000000d002';
update public.driver_profiles set full_name = 'DEMO Pending Person'
 where user_id = '00000000-0000-4000-8000-00000000d003';

insert into public.driver_destination_defaults (driver_id, destination_id, accepted, min_rate_cents)
select p.user_id, d.id, true, d.preset_payout_cents
from public.driver_profiles p cross join public.destinations d
where p.status = 'APPROVED' and p.user_id <> '00000000-0000-4000-8000-00000000a001'
on conflict do nothing;

insert into public.vehicles (id, driver_id, name, make_model, vehicle_type, max_passengers, max_luggage, is_default) values
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-00000000d001', 'DEMO Suburban', 'Chevrolet Suburban', 'SUV', 6, 6, true),
  ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000d002', 'DEMO Sedan', 'Toyota Camry', 'SEDAN', 3, 3, true)
on conflict do nothing;

-- Dana: weekday mornings, recurring. Eli: one afternoon block this week.
insert into public.availability_rules (id, driver_id, weekdays, local_start, local_end, effective_from, status, vehicle_id)
values ('00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-00000000d001', '{1,2,3,4,5}', '06:00', '14:00',
        current_date - 7, 'AVAILABLE', '00000000-0000-4000-8000-0000000000c1')
on conflict do nothing;
insert into public.availability_rule_destinations (rule_id, destination_id, min_rate_cents)
select '00000000-0000-4000-8000-0000000000f1', id, null from public.destinations where code in ('EWR', 'JFK', 'NYC')
on conflict do nothing;

insert into public.availability_blocks (id, driver_id, start_at, end_at, status, vehicle_id)
values ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-00000000d002',
        ((current_date + 1) + time '12:00') at time zone 'America/New_York',
        ((current_date + 1) + time '20:00') at time zone 'America/New_York', 'AVAILABLE', '00000000-0000-4000-8000-0000000000e1')
on conflict do nothing;
insert into public.availability_block_destinations (block_id, destination_id, min_rate_cents)
select '00000000-0000-4000-8000-0000000000b1', id, case when code = 'NYC' then 17000 else null end
from public.destinations where code in ('NYC', 'LGA')
on conflict do nothing;
