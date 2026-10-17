-- Authorization: helper functions, grants and Row Level Security.
--
-- Model
-- - Every table has RLS enabled; anon gets nothing.
-- - Drivers can SELECT only their own rows, and only once APPROVED.
--   (A pending/rejected/suspended user can read just their own profile row.)
-- - Drivers never write tables directly: every driver mutation goes through a
--   SECURITY DEFINER function that uses auth.uid(), validates, enforces the
--   short-notice window and writes the audit entry.
-- - Admin status comes from public.user_roles, which no client can write.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.user_roles r
    where r.user_id = (select auth.uid()) and r.role = 'ADMIN'
  );
$$;

create or replace function public.is_approved_driver()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.driver_profiles p
    where p.user_id = (select auth.uid()) and p.status = 'APPROVED'
  );
$$;

-- True when the caller may read data belonging to driver p_driver.
create or replace function public.can_read_driver(p_driver uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_admin()
      or (p_driver = (select auth.uid()) and public.is_approved_driver());
$$;

revoke all on function public.is_admin() from public;
revoke all on function public.is_approved_driver() from public;
revoke all on function public.can_read_driver(uuid) from public;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_approved_driver() to authenticated;
grant execute on function public.can_read_driver(uuid) to authenticated;

-- Raise a client-readable error. Format: "<CODE>: <message>".
create or replace function public.app_error(p_code text, p_message text)
returns void language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = p_code || ': ' || p_message;
end $$;

-- ---------------------------------------------------------------------------
-- Grants: start from nothing, then add the minimum.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon;

-- Read access (RLS still filters every row).
grant select on
  public.user_roles,
  public.driver_profiles,
  public.vehicles,
  public.destinations,
  public.driver_destination_defaults,
  public.availability_rules,
  public.availability_rule_destinations,
  public.availability_blocks,
  public.availability_block_destinations,
  public.rule_exceptions,
  public.time_off,
  public.admin_unavailability,
  public.schedule_templates,
  public.change_requests,
  public.notification_categories,
  public.notification_preferences,
  -- admin-only tables (RLS limits these to admins)
  public.app_settings,
  public.admin_driver_notes,
  public.calendar_connections,
  public.reservations,
  public.reservation_corrections,
  public.reservation_markers,
  public.parsing_rules,
  public.rate_mappings,
  public.driver_aliases,
  public.sync_runs,
  public.eligibility_overrides,
  public.notification_deliveries,
  public.audit_log
to authenticated;

-- Admin configuration tables may be edited directly by admins (RLS-checked, audited by trigger).
grant insert, update on public.destinations, public.app_settings, public.notification_categories to authenticated;
grant insert, update, delete on public.parsing_rules, public.rate_mappings, public.reservation_markers,
  public.driver_aliases, public.admin_driver_notes, public.reservation_corrections to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.user_roles enable row level security;
alter table public.driver_profiles enable row level security;
alter table public.admin_driver_notes enable row level security;
alter table public.vehicles enable row level security;
alter table public.destinations enable row level security;
alter table public.app_settings enable row level security;
alter table public.driver_destination_defaults enable row level security;
alter table public.availability_rules enable row level security;
alter table public.availability_rule_destinations enable row level security;
alter table public.availability_blocks enable row level security;
alter table public.availability_block_destinations enable row level security;
alter table public.rule_exceptions enable row level security;
alter table public.time_off enable row level security;
alter table public.admin_unavailability enable row level security;
alter table public.schedule_templates enable row level security;
alter table public.change_requests enable row level security;
alter table public.calendar_connections enable row level security;
alter table public.oauth_states enable row level security;
alter table public.reservations enable row level security;
alter table public.reservation_corrections enable row level security;
alter table public.reservation_markers enable row level security;
alter table public.parsing_rules enable row level security;
alter table public.rate_mappings enable row level security;
alter table public.driver_aliases enable row level security;
alter table public.sync_runs enable row level security;
alter table public.eligibility_overrides enable row level security;
alter table public.notification_categories enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.notification_deliveries enable row level security;
alter table public.audit_log enable row level security;

-- Accounts
create policy user_roles_read on public.user_roles for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

create policy driver_profiles_read on public.driver_profiles for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

create policy admin_driver_notes_admin on public.admin_driver_notes for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Driver-owned data: own rows once approved, or admin.
create policy vehicles_read on public.vehicles for select to authenticated
  using (public.can_read_driver(driver_id));
create policy driver_destination_defaults_read on public.driver_destination_defaults for select to authenticated
  using (public.can_read_driver(driver_id));
create policy availability_rules_read on public.availability_rules for select to authenticated
  using (public.can_read_driver(driver_id));
create policy availability_rule_destinations_read on public.availability_rule_destinations for select to authenticated
  using (exists (select 1 from public.availability_rules r where r.id = rule_id and public.can_read_driver(r.driver_id)));
create policy availability_blocks_read on public.availability_blocks for select to authenticated
  using (public.can_read_driver(driver_id));
create policy availability_block_destinations_read on public.availability_block_destinations for select to authenticated
  using (exists (select 1 from public.availability_blocks b where b.id = block_id and public.can_read_driver(b.driver_id)));
create policy rule_exceptions_read on public.rule_exceptions for select to authenticated
  using (exists (select 1 from public.availability_rules r where r.id = rule_id and public.can_read_driver(r.driver_id)));
create policy time_off_read on public.time_off for select to authenticated
  using (public.can_read_driver(driver_id));
create policy admin_unavailability_read on public.admin_unavailability for select to authenticated
  using (public.can_read_driver(driver_id));
create policy schedule_templates_read on public.schedule_templates for select to authenticated
  using (public.can_read_driver(driver_id));
create policy change_requests_read on public.change_requests for select to authenticated
  using (public.can_read_driver(driver_id));

-- Reference data
create policy destinations_read on public.destinations for select to authenticated
  using (public.is_approved_driver() or public.is_admin());
create policy destinations_admin_insert on public.destinations for insert to authenticated
  with check (public.is_admin());
create policy destinations_admin_update on public.destinations for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy app_settings_admin_read on public.app_settings for select to authenticated using (public.is_admin());
create policy app_settings_admin_update on public.app_settings for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy notification_categories_read on public.notification_categories for select to authenticated
  using (public.is_approved_driver() or public.is_admin());
create policy notification_categories_admin on public.notification_categories for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy notification_categories_admin_insert on public.notification_categories for insert to authenticated
  with check (public.is_admin());

create policy notification_preferences_read on public.notification_preferences for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

-- Admin-only operational data. No driver-facing policy exists on these tables.
create policy calendar_connections_admin on public.calendar_connections for select to authenticated using (public.is_admin());
create policy reservations_admin on public.reservations for select to authenticated using (public.is_admin());
create policy reservation_corrections_admin on public.reservation_corrections for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy reservation_markers_admin on public.reservation_markers for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy parsing_rules_admin on public.parsing_rules for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy rate_mappings_admin on public.rate_mappings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy driver_aliases_admin on public.driver_aliases for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy sync_runs_admin on public.sync_runs for select to authenticated using (public.is_admin());
create policy eligibility_overrides_admin on public.eligibility_overrides for select to authenticated using (public.is_admin());
create policy notification_deliveries_admin on public.notification_deliveries for select to authenticated using (public.is_admin());
create policy audit_log_admin on public.audit_log for select to authenticated using (public.is_admin());
-- oauth_states: no policies at all → only the service role (Edge Functions) can touch it.

-- Column-level hardening: the calendar connection's Vault pointer is never selectable by clients.
revoke select on public.calendar_connections from authenticated;
grant select (id, google_account_email, calendar_id, calendar_name, scopes, status, last_success_at, last_error,
  connected_by, connected_at, created_at, updated_at, version) on public.calendar_connections to authenticated;
