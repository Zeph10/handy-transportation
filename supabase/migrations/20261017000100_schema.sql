-- Handy Transportation: core schema
-- Conventions: money = integer cents; instants = timestamptz (UTC);
-- local dates/times are America/New_York wall-clock values;
-- mutable tables carry created_at, updated_at, version (optimistic concurrency).

create extension if not exists btree_gist with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------
create type public.app_role as enum ('DRIVER', 'ADMIN');
create type public.driver_status as enum ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'SUSPENDED');
create type public.vehicle_type as enum ('SEDAN', 'SUV', 'VAN', 'SPRINTER', 'MINIBUS', 'OTHER');
create type public.destination_kind as enum ('AIRPORT', 'CITY', 'GENERAL', 'CUSTOM');
create type public.availability_status as enum ('AVAILABLE', 'TENTATIVE', 'UNAVAILABLE');
create type public.block_origin as enum ('DRIVER', 'ADMIN', 'COPY', 'TEMPLATE');
create type public.change_request_status as enum ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');
create type public.change_request_action as enum ('ADD_BLOCK', 'UPDATE_BLOCK', 'DELETE_BLOCK', 'ADD_TIME_OFF', 'SKIP_OCCURRENCE');
create type public.connection_status as enum ('CONNECTED', 'EXPIRED', 'ERROR', 'DISCONNECTED');
create type public.sync_status as enum ('RUNNING', 'SUCCEEDED', 'FAILED');
create type public.congestion_state as enum ('YES', 'NO', 'UNKNOWN');
create type public.assignment_state as enum ('UNFILLED', 'ASSIGNED', 'ASSIGNED_UNKNOWN', 'NOT_A_RESERVATION');
create type public.parse_source as enum ('SUMMARY', 'DESCRIPTION', 'LOCATION');
create type public.delivery_status as enum ('QUEUED', 'SENT', 'FAILED', 'SKIPPED');

-- Shared trigger: bump version + updated_at on every update.
create or replace function public.tg_touch_row()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  new.version := old.version + 1;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Accounts and drivers
-- ---------------------------------------------------------------------------
create table public.user_roles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role public.app_role not null default 'DRIVER',
  created_at timestamptz not null default now()
);

create table public.driver_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '' check (char_length(full_name) <= 120),
  email text not null check (char_length(email) <= 320),
  phone text check (phone is null or char_length(phone) <= 32),
  status public.driver_status not null default 'PENDING_APPROVAL',
  status_reason text check (status_reason is null or char_length(status_reason) <= 500),
  status_changed_at timestamptz,
  status_changed_by uuid references auth.users (id),
  driver_notes text check (driver_notes is null or char_length(driver_notes) <= 1000),
  onboarding_completed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create index driver_profiles_status_idx on public.driver_profiles (status);
create trigger driver_profiles_touch before update on public.driver_profiles for each row execute function public.tg_touch_row();

-- Private notes: a separate table so no driver-facing policy can ever expose them.
create table public.admin_driver_notes (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.driver_profiles (user_id) on delete cascade,
  body text not null check (char_length(body) between 1 and 4000),
  author_id uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create index admin_driver_notes_driver_idx on public.admin_driver_notes (driver_id);
create trigger admin_driver_notes_touch before update on public.admin_driver_notes for each row execute function public.tg_touch_row();

create table public.vehicles (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.driver_profiles (user_id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  make_model text check (make_model is null or char_length(make_model) <= 120),
  vehicle_type public.vehicle_type not null default 'SEDAN',
  max_passengers integer not null check (max_passengers between 1 and 60),
  max_luggage integer check (max_luggage is null or max_luggage between 0 and 100),
  accessibility_notes text check (accessibility_notes is null or char_length(accessibility_notes) <= 500),
  is_active boolean not null default true,
  is_default boolean not null default false,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create index vehicles_driver_idx on public.vehicles (driver_id);
create unique index vehicles_one_default_per_driver on public.vehicles (driver_id) where is_default and deleted_at is null;
create trigger vehicles_touch before update on public.vehicles for each row execute function public.tg_touch_row();

-- ---------------------------------------------------------------------------
-- Destinations and settings
-- ---------------------------------------------------------------------------
create table public.destinations (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9_]{2,16}$'),
  name text not null check (char_length(name) between 1 and 80),
  kind public.destination_kind not null default 'CUSTOM',
  preset_payout_cents integer not null check (preset_payout_cents between 0 and 1000000),
  est_duration_minutes integer check (est_duration_minutes is null or est_duration_minutes between 1 and 1440),
  congestion_eligible boolean not null default false,
  sort_order integer not null default 100,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create trigger destinations_touch before update on public.destinations for each row execute function public.tg_touch_row();

create table public.app_settings (
  id integer primary key default 1 check (id = 1),
  environment text not null default 'development' check (environment in ('development', 'staging', 'production')),
  congestion_surcharge_cents integer not null default 900 check (congestion_surcharge_cents between 0 and 100000),
  travel_to_pickup_minutes integer not null default 60 check (travel_to_pickup_minutes between 0 and 600),
  post_trip_buffer_minutes integer not null default 30 check (post_trip_buffer_minutes between 0 and 600),
  short_notice_window_hours integer not null default 24 check (short_notice_window_hours between 0 and 336),
  submission_deadline_dow integer not null default 4 check (submission_deadline_dow between 1 and 7),
  submission_deadline_time time not null default '18:00',
  require_approval boolean not null default true,
  assume_preset_when_payout_missing boolean not null default true,
  sync_window_past_days integer not null default 30 check (sync_window_past_days between 0 and 365),
  sync_window_future_days integer not null default 180 check (sync_window_future_days between 1 and 730),
  stale_after_hours integer not null default 24 check (stale_after_hours between 1 and 720),
  reminder_enabled boolean not null default true,
  reminder_dow integer not null default 3 check (reminder_dow between 1 and 7),
  reminder_time time not null default '10:00',
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create trigger app_settings_touch before update on public.app_settings for each row execute function public.tg_touch_row();

create table public.driver_destination_defaults (
  driver_id uuid not null references public.driver_profiles (user_id) on delete cascade,
  destination_id uuid not null references public.destinations (id) on delete cascade,
  accepted boolean not null default true,
  min_rate_cents integer check (min_rate_cents is null or min_rate_cents between 0 and 1000000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  primary key (driver_id, destination_id)
);
create trigger driver_destination_defaults_touch before update on public.driver_destination_defaults for each row execute function public.tg_touch_row();

-- ---------------------------------------------------------------------------
-- Availability
-- ---------------------------------------------------------------------------
create table public.availability_rules (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.driver_profiles (user_id) on delete cascade,
  weekdays smallint[] not null check (
    cardinality(weekdays) between 1 and 7
    and weekdays <@ array[1,2,3,4,5,6,7]::smallint[]
  ),
  local_start time not null,
  local_end time not null,
  end_day_offset smallint not null default 0 check (end_day_offset in (0, 1)),
  effective_from date not null,
  effective_until date,
  status public.availability_status not null default 'AVAILABLE',
  vehicle_id uuid references public.vehicles (id),
  notes text check (notes is null or char_length(notes) <= 1000),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  check (effective_until is null or effective_until >= effective_from),
  check ((end_day_offset = 0 and local_end > local_start) or (end_day_offset = 1 and local_end <= local_start)),
  check (status = 'UNAVAILABLE' or vehicle_id is not null)
);
create index availability_rules_driver_idx on public.availability_rules (driver_id) where deleted_at is null;
create trigger availability_rules_touch before update on public.availability_rules for each row execute function public.tg_touch_row();

create table public.availability_rule_destinations (
  rule_id uuid not null references public.availability_rules (id) on delete cascade,
  destination_id uuid not null references public.destinations (id),
  min_rate_cents integer check (min_rate_cents is null or min_rate_cents between 0 and 1000000),
  primary key (rule_id, destination_id)
);

create table public.availability_blocks (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.driver_profiles (user_id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz not null,
  status public.availability_status not null default 'AVAILABLE',
  vehicle_id uuid references public.vehicles (id),
  notes text check (notes is null or char_length(notes) <= 1000),
  rule_id uuid references public.availability_rules (id),
  occurrence_date date,
  origin public.block_origin not null default 'DRIVER',
  deleted_at timestamptz,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  check (end_at > start_at),
  check (end_at - start_at <= interval '7 days'),
  check ((rule_id is null) = (occurrence_date is null)),
  check (status = 'UNAVAILABLE' or vehicle_id is not null),
  -- A driver can never have two live blocks covering the same instant.
  constraint availability_blocks_no_overlap exclude using gist (
    driver_id with =,
    tstzrange(start_at, end_at, '[)') with &&
  ) where (deleted_at is null)
);
create index availability_blocks_driver_time_idx on public.availability_blocks (driver_id, start_at) where deleted_at is null;
create index availability_blocks_time_idx on public.availability_blocks using gist (tstzrange(start_at, end_at, '[)')) where deleted_at is null;
create unique index availability_blocks_one_per_occurrence on public.availability_blocks (rule_id, occurrence_date) where deleted_at is null and rule_id is not null;
create trigger availability_blocks_touch before update on public.availability_blocks for each row execute function public.tg_touch_row();

create table public.availability_block_destinations (
  block_id uuid not null references public.availability_blocks (id) on delete cascade,
  destination_id uuid not null references public.destinations (id),
  min_rate_cents integer check (min_rate_cents is null or min_rate_cents between 0 and 1000000),
  primary key (block_id, destination_id)
);

create table public.rule_exceptions (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid not null references public.availability_rules (id) on delete cascade,
  occurrence_date date not null,
  kind text not null default 'SKIP' check (kind = 'SKIP'),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  unique (rule_id, occurrence_date)
);

create table public.time_off (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.driver_profiles (user_id) on delete cascade,
  start_date date not null,
  end_date date not null,
  note text check (note is null or char_length(note) <= 500),
  deleted_at timestamptz,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  check (end_date >= start_date),
  check (end_date - start_date <= 366)
);
create index time_off_driver_idx on public.time_off (driver_id, start_date) where deleted_at is null;
create trigger time_off_touch before update on public.time_off for each row execute function public.tg_touch_row();

-- Admin "mark unavailable": a top layer that never edits the driver's own entries.
create table public.admin_unavailability (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.driver_profiles (user_id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz not null,
  reason text check (reason is null or char_length(reason) <= 500),
  deleted_at timestamptz,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  check (end_at > start_at),
  check (end_at - start_at <= interval '31 days')
);
create index admin_unavailability_driver_idx on public.admin_unavailability (driver_id, start_at) where deleted_at is null;
create trigger admin_unavailability_touch before update on public.admin_unavailability for each row execute function public.tg_touch_row();

create table public.schedule_templates (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.driver_profiles (user_id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  span text not null default 'WEEK' check (span in ('DAY', 'WEEK')),
  blocks jsonb not null check (jsonb_typeof(blocks) = 'array' and jsonb_array_length(blocks) between 1 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (driver_id, name)
);
create trigger schedule_templates_touch before update on public.schedule_templates for each row execute function public.tg_touch_row();

create table public.change_requests (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.driver_profiles (user_id) on delete cascade,
  action public.change_request_action not null,
  target_id uuid,
  prior jsonb,
  proposed jsonb,
  status public.change_request_status not null default 'PENDING',
  driver_message text check (driver_message is null or char_length(driver_message) <= 500),
  decided_by uuid references auth.users (id),
  decided_at timestamptz,
  decision_reason text check (decision_reason is null or char_length(decision_reason) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create index change_requests_pending_idx on public.change_requests (status, created_at) where status = 'PENDING';
create index change_requests_driver_idx on public.change_requests (driver_id, created_at desc);
create unique index change_requests_one_pending_per_target on public.change_requests (target_id) where status = 'PENDING' and target_id is not null;
create trigger change_requests_touch before update on public.change_requests for each row execute function public.tg_touch_row();

-- ---------------------------------------------------------------------------
-- Google Calendar and reservations (admin only)
-- ---------------------------------------------------------------------------
create table public.calendar_connections (
  id uuid primary key default gen_random_uuid(),
  google_account_email text,
  calendar_id text,
  calendar_name text,
  scopes text[] not null default '{}',
  vault_secret_id uuid,
  status public.connection_status not null default 'DISCONNECTED',
  last_success_at timestamptz,
  last_error text,
  connected_by uuid references auth.users (id),
  connected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
-- Only one active connection at a time.
create unique index calendar_connections_one_active on public.calendar_connections ((true)) where status <> 'DISCONNECTED';
create trigger calendar_connections_touch before update on public.calendar_connections for each row execute function public.tg_touch_row();

-- Short-lived OAuth state nonces (CSRF protection for the OAuth callback).
create table public.oauth_states (
  nonce text primary key,
  admin_id uuid not null references auth.users (id) on delete cascade,
  code_verifier text not null,
  created_at timestamptz not null default now(),
  used_at timestamptz
);

create table public.reservations (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.calendar_connections (id) on delete cascade,
  google_event_id text not null,
  ical_uid text,
  recurring_event_id text,
  original_start timestamptz,
  etag text,
  google_updated_at timestamptz,
  source_status text,
  removed_from_source boolean not null default false,
  raw_summary text,
  raw_description text,
  raw_location text,
  attendee_emails text[] not null default '{}',
  start_at timestamptz,
  end_at timestamptz,
  all_day boolean not null default false,
  parsed jsonb not null default '{}'::jsonb,
  parser_version integer not null default 0,
  is_reservation boolean not null default false,
  trip_ref text,
  destination_code text,
  passengers integer,
  checked_bags integer,
  assignment public.assignment_state not null default 'NOT_A_RESERVATION',
  assigned_driver_id uuid references public.driver_profiles (user_id) on delete set null,
  congestion public.congestion_state not null default 'UNKNOWN',
  payout_cents integer,
  review_flags text[] not null default '{}',
  first_seen_at timestamptz not null default now(),
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (connection_id, google_event_id)
);
create index reservations_start_idx on public.reservations (start_at) where not removed_from_source;
create index reservations_unfilled_idx on public.reservations (start_at) where assignment = 'UNFILLED' and not removed_from_source;
create index reservations_driver_idx on public.reservations (assigned_driver_id, start_at);
create trigger reservations_touch before update on public.reservations for each row execute function public.tg_touch_row();

-- Local admin corrections. Never written back to Google.
create table public.reservation_corrections (
  reservation_id uuid primary key references public.reservations (id) on delete cascade,
  is_reservation boolean,
  destination_id uuid references public.destinations (id),
  passenger_count integer check (passenger_count is null or passenger_count between 0 and 60),
  checked_bags integer check (checked_bags is null or checked_bags between 0 and 100),
  assigned_driver_id uuid references public.driver_profiles (user_id) on delete set null,
  clear_assignment boolean not null default false,
  proposed_payout_cents integer check (proposed_payout_cents is null or proposed_payout_cents between 0 and 1000000),
  congestion public.congestion_state,
  duration_minutes integer check (duration_minutes is null or duration_minutes between 1 and 1440),
  notes text check (notes is null or char_length(notes) <= 2000),
  updated_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create trigger reservation_corrections_touch before update on public.reservation_corrections for each row execute function public.tg_touch_row();

create table public.reservation_markers (
  id uuid primary key default gen_random_uuid(),
  source public.parse_source not null,
  pattern text not null check (char_length(pattern) between 1 and 500),
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.parsing_rules (
  id uuid primary key default gen_random_uuid(),
  field text not null check (field in ('tripRef','tripStatus','customerName','pickupTimeText','pickupAddress','dropoffAddress',
    'passengers','checkedBags','carryOnBags','flight','rateLabel','driverLine','vehicle','payout')),
  source public.parse_source not null,
  pattern text not null check (char_length(pattern) between 1 and 500),
  priority integer not null default 100,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create trigger parsing_rules_touch before update on public.parsing_rules for each row execute function public.tg_touch_row();

create table public.rate_mappings (
  id uuid primary key default gen_random_uuid(),
  pattern text not null check (char_length(pattern) between 1 and 500),
  destination_code text not null references public.destinations (code) on update cascade,
  congestion public.congestion_state,
  priority integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create trigger rate_mappings_touch before update on public.rate_mappings for each row execute function public.tg_touch_row();

create table public.driver_aliases (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.driver_profiles (user_id) on delete cascade,
  alias text not null check (char_length(btrim(alias)) between 1 and 120),
  created_at timestamptz not null default now()
);
create unique index driver_aliases_unique on public.driver_aliases (lower(btrim(alias)));

create table public.sync_runs (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid references public.calendar_connections (id) on delete set null,
  started_by uuid references auth.users (id),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status public.sync_status not null default 'RUNNING',
  window_start timestamptz,
  window_end timestamptz,
  events_seen integer not null default 0,
  inserted integer not null default 0,
  updated integer not null default 0,
  unchanged integer not null default 0,
  removed integer not null default 0,
  error text
);
-- At most one running sync: a second concurrent start fails on this index.
create unique index sync_runs_one_running on public.sync_runs ((true)) where status = 'RUNNING';
create index sync_runs_started_idx on public.sync_runs (started_at desc);

create table public.eligibility_overrides (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations (id) on delete cascade,
  driver_id uuid not null references public.driver_profiles (user_id) on delete cascade,
  reason text not null check (char_length(btrim(reason)) between 3 and 500),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id)
);
create unique index eligibility_overrides_one_active on public.eligibility_overrides (reservation_id, driver_id) where revoked_at is null;

-- ---------------------------------------------------------------------------
-- Notifications and audit
-- ---------------------------------------------------------------------------
create table public.notification_categories (
  code text primary key check (code ~ '^[A-Z_]{3,40}$'),
  description text not null,
  enabled_globally boolean not null default false,
  default_on boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create trigger notification_categories_touch before update on public.notification_categories for each row execute function public.tg_touch_row();

create table public.notification_preferences (
  user_id uuid not null references auth.users (id) on delete cascade,
  category text not null references public.notification_categories (code) on delete cascade,
  enabled boolean not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, category)
);

create table public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,
  category text not null references public.notification_categories (code),
  dedupe_key text not null unique,
  status public.delivery_status not null default 'QUEUED',
  provider_message_id text,
  attempts integer not null default 0,
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index notification_deliveries_user_idx on public.notification_deliveries (user_id, created_at desc);

create table public.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid,
  actor_role text,
  action text not null,
  entity_table text not null,
  entity_id text,
  affected_driver_id uuid,
  reason text,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_created_idx on public.audit_log (created_at desc);
create index audit_log_driver_idx on public.audit_log (affected_driver_id, created_at desc);
create index audit_log_entity_idx on public.audit_log (entity_table, entity_id);
