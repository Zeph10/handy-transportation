-- Generic audit trigger for tables without child rows. Availability blocks and
-- rules are audited by their functions (so the snapshot includes destinations).

create or replace function public.tg_audit_row()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_before jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_after jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_row jsonb := coalesce(v_after, v_before);
  v_driver uuid;
  v_entity text;
begin
  if tg_op = 'UPDATE' and (v_before - 'updated_at' - 'version') = (v_after - 'updated_at' - 'version') then
    return null; -- nothing meaningful changed
  end if;
  v_driver := coalesce(nullif(v_row->>'driver_id', ''), nullif(v_row->>'user_id', ''))::uuid;
  if tg_table_name = 'driver_profiles' or tg_table_name = 'user_roles' then v_driver := (v_row->>'user_id')::uuid; end if;
  v_entity := coalesce(v_row->>'id', v_row->>'user_id', v_row->>'reservation_id', v_row->>'code',
                       (v_row->>'driver_id') || ':' || (v_row->>'destination_id'));
  perform public.write_audit(lower(tg_op), tg_table_name, v_entity, v_driver, v_before, v_after);
  return null;
end $$;
revoke all on function public.tg_audit_row() from public, anon, authenticated;

create trigger audit_user_roles after insert or update or delete on public.user_roles for each row execute function public.tg_audit_row();
create trigger audit_destinations after insert or update or delete on public.destinations for each row execute function public.tg_audit_row();
create trigger audit_app_settings after insert or update on public.app_settings for each row execute function public.tg_audit_row();
create trigger audit_time_off after insert or update or delete on public.time_off for each row execute function public.tg_audit_row();
create trigger audit_admin_unavailability after insert or update or delete on public.admin_unavailability for each row execute function public.tg_audit_row();
create trigger audit_change_requests after update on public.change_requests for each row execute function public.tg_audit_row();
create trigger audit_admin_driver_notes after insert or update or delete on public.admin_driver_notes for each row execute function public.tg_audit_row();
create trigger audit_calendar_connections after insert or update on public.calendar_connections for each row execute function public.tg_audit_row();
create trigger audit_reservation_corrections after insert or update or delete on public.reservation_corrections for each row execute function public.tg_audit_row();
create trigger audit_parsing_rules after insert or update or delete on public.parsing_rules for each row execute function public.tg_audit_row();
create trigger audit_rate_mappings after insert or update or delete on public.rate_mappings for each row execute function public.tg_audit_row();
create trigger audit_reservation_markers after insert or update or delete on public.reservation_markers for each row execute function public.tg_audit_row();
create trigger audit_driver_aliases after insert or update or delete on public.driver_aliases for each row execute function public.tg_audit_row();
create trigger audit_eligibility_overrides after insert or update on public.eligibility_overrides for each row execute function public.tg_audit_row();
create trigger audit_notification_categories after insert or update on public.notification_categories for each row execute function public.tg_audit_row();
create trigger audit_sync_runs after insert or update of status on public.sync_runs for each row execute function public.tg_audit_row();

-- Audit log is append-only even for admins.
revoke insert, update, delete, truncate on public.audit_log from authenticated, anon;

-- ---------------------------------------------------------------------------
-- Reference data (real configuration, not demo data)
-- ---------------------------------------------------------------------------
insert into public.app_settings (id) values (1) on conflict (id) do nothing;

insert into public.destinations (code, name, kind, preset_payout_cents, congestion_eligible, sort_order) values
  ('EWR', 'EWR', 'AIRPORT', 11000, false, 10),
  ('LGA', 'LGA', 'AIRPORT', 16500, false, 20),
  ('JFK', 'JFK', 'AIRPORT', 21000, false, 30),
  ('NYC', 'NYC', 'CITY', 16000, true, 40),
  ('OTHER', 'Other / General Trips', 'GENERAL', 0, false, 90)
on conflict (code) do nothing;

insert into public.notification_categories (code, description, enabled_globally, default_on) values
  ('WEEKLY_REMINDER', 'Weekly reminder to share next week''s availability (optional)', true, true),
  ('MISSING_AVAILABILITY', 'Reminder when no availability is shared for the coming days', false, false),
  ('ADMIN_CHANGED_AVAILABILITY', 'Email when the dispatcher changes your availability', false, false),
  ('CHANGE_REQUEST_DECIDED', 'Email when a short-notice change is approved or declined', false, false),
  ('ADMIN_CHANGE_REQUESTS', 'Email to admins when a change needs approval', false, false),
  ('ANNOUNCEMENT', 'System announcements', false, false)
on conflict (code) do nothing;

-- Parser defaults for the booking system's format (mirror of core/src/parser.ts DEFAULT_*).
insert into public.reservation_markers (source, pattern) values
  ('DESCRIPTION', '^[ \t]*Trip:[ \t]*TRP-\d+'),
  ('SUMMARY', '^\s*HANDY TRANSPORTATION LLC CONFIRMATION');

insert into public.parsing_rules (field, source, pattern, priority) values
  ('tripRef', 'DESCRIPTION', '^[ \t]*Trip:[ \t]*(TRP-\d+)', 10),
  ('tripStatus', 'DESCRIPTION', '^[ \t]*Trip:[ \t]*TRP-\d+[ \t]*\(([^)]+)\)', 10),
  ('customerName', 'DESCRIPTION', '^[ \t]*Customer:[ \t]*(.+?)[ \t]*$', 10),
  ('pickupTimeText', 'DESCRIPTION', '^[ \t]*Pickup time:[ \t]*(.+?)[ \t]*$', 10),
  ('pickupAddress', 'DESCRIPTION', '^[ \t]*Pickup:[ \t]*(.+?)[ \t]*$', 10),
  ('pickupAddress', 'SUMMARY', 'pick up .+? from (.+?), @', 20),
  ('pickupAddress', 'LOCATION', '^(.+)$', 30),
  ('dropoffAddress', 'DESCRIPTION', '^[ \t]*Drop-off:[ \t]*(.+?)[ \t]*$', 10),
  ('dropoffAddress', 'SUMMARY', 'heading towards (.+?)\.\s*Flight Number', 20),
  ('passengers', 'DESCRIPTION', '^[ \t]*Passengers:[ \t]*(\d+)', 10),
  ('passengers', 'SUMMARY', 'Passenger Count:\s*(\d+)', 20),
  ('checkedBags', 'DESCRIPTION', 'Bags:[ \t]*(\d+)[ \t]*checked', 10),
  ('checkedBags', 'SUMMARY', 'Checked Bags:\s*(\d+)', 20),
  ('carryOnBags', 'DESCRIPTION', '(\d+)[ \t]*carry-on', 10),
  ('carryOnBags', 'SUMMARY', 'Carry On Bags:\s*(\d+)', 20),
  ('flight', 'DESCRIPTION', '^[ \t]*Flight:[ \t]*(.+?)[ \t]*$', 10),
  ('rateLabel', 'DESCRIPTION', '^[ \t]*Rate:[ \t]*(.+?)[ \t]*$', 10),
  ('driverLine', 'DESCRIPTION', '^[ \t]*Driver:[ \t]*(.+?)[ \t]*$', 10),
  ('driverLine', 'SUMMARY', '^[ \t]*Driver:[ \t]*(.+?)[ \t]*$', 20),
  ('vehicle', 'DESCRIPTION', '^[ \t]*Vehicle:[ \t]*(.+?)[ \t]*$', 10);

insert into public.rate_mappings (pattern, destination_code, congestion, priority) values
  ('^EWR\b', 'EWR', null, 10),
  ('^LGA\b', 'LGA', null, 10),
  ('^JFK\b', 'JFK', null, 10),
  ('^New York City\b.*\bCongestion\b', 'NYC', 'YES', 5),
  ('^New York City\b', 'NYC', null, 10);
