// Row shapes returned by the database (snake_case, as PostgREST returns them).

export type DriverStatus = 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
export type AppRole = 'DRIVER' | 'ADMIN';
export type AvailabilityStatus = 'AVAILABLE' | 'TENTATIVE' | 'UNAVAILABLE';

export interface ProfileRow {
  user_id: string;
  full_name: string;
  email: string;
  phone: string | null;
  status: DriverStatus;
  status_reason: string | null;
  driver_notes: string | null;
  onboarding_completed: boolean;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface VehicleRow {
  id: string;
  driver_id: string;
  name: string;
  make_model: string | null;
  vehicle_type: 'SEDAN' | 'SUV' | 'VAN' | 'SPRINTER' | 'MINIBUS' | 'OTHER';
  max_passengers: number;
  max_luggage: number | null;
  accessibility_notes: string | null;
  is_active: boolean;
  is_default: boolean;
  deleted_at: string | null;
  version: number;
}

export interface DestinationRow {
  id: string;
  code: string;
  name: string;
  kind: 'AIRPORT' | 'CITY' | 'GENERAL' | 'CUSTOM';
  preset_payout_cents: number;
  est_duration_minutes: number | null;
  congestion_eligible: boolean;
  sort_order: number;
  is_active: boolean;
  version: number;
}

export interface DestinationDefaultRow {
  driver_id: string;
  destination_id: string;
  accepted: boolean;
  min_rate_cents: number | null;
}

export interface DestOfferRow {
  destination_id: string;
  min_rate_cents: number | null;
}

export interface BlockRow {
  id: string;
  driver_id: string;
  start_at: string;
  end_at: string;
  status: AvailabilityStatus;
  vehicle_id: string | null;
  notes: string | null;
  rule_id: string | null;
  occurrence_date: string | null;
  origin: 'DRIVER' | 'ADMIN' | 'COPY' | 'TEMPLATE';
  version: number;
  availability_block_destinations: DestOfferRow[];
}

export interface RuleRow {
  id: string;
  driver_id: string;
  weekdays: number[];
  local_start: string; // HH:MM:SS
  local_end: string;
  end_day_offset: 0 | 1;
  effective_from: string;
  effective_until: string | null;
  status: AvailabilityStatus;
  vehicle_id: string | null;
  notes: string | null;
  version: number;
  availability_rule_destinations: DestOfferRow[];
}

export interface ExceptionRow {
  rule_id: string;
  occurrence_date: string;
}

export interface TimeOffRow {
  id: string;
  driver_id: string;
  start_date: string;
  end_date: string;
  note: string | null;
  version: number;
}

export interface AdminUnavailabilityRow {
  id: string;
  driver_id: string;
  start_at: string;
  end_at: string;
  reason: string | null;
}

export interface ChangeRequestRow {
  id: string;
  driver_id: string;
  action: 'ADD_BLOCK' | 'UPDATE_BLOCK' | 'DELETE_BLOCK' | 'ADD_TIME_OFF' | 'SKIP_OCCURRENCE';
  target_id: string | null;
  prior: Record<string, unknown> | null;
  proposed: Record<string, unknown> | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN';
  driver_message: string | null;
  decision_reason: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface TemplateRow {
  id: string;
  name: string;
  span: 'DAY' | 'WEEK';
  blocks: unknown[];
}

export interface PublicSettings {
  environment: 'development' | 'staging' | 'production';
  congestion_surcharge_cents: number;
  short_notice_window_hours: number;
  submission_deadline_dow: number;
  submission_deadline_time: string;
}

export interface AppSettingsRow extends Omit<PublicSettings, 'submission_deadline_time'> {
  id: 1;
  submission_deadline_time: string;
  travel_to_pickup_minutes: number;
  post_trip_buffer_minutes: number;
  require_approval: boolean;
  assume_preset_when_payout_missing: boolean;
  sync_window_past_days: number;
  sync_window_future_days: number;
  stale_after_hours: number;
  reminder_enabled: boolean;
  reminder_dow: number;
  reminder_time: string;
  version: number;
}

export interface ReservationEffectiveRow {
  id: string;
  google_event_id: string;
  trip_ref: string | null;
  pickup_at: string | null;
  event_end_at: string | null;
  all_day: boolean;
  source_status: string | null;
  removed_from_source: boolean;
  last_synced_at: string;
  review_flags: string[];
  parsed: Record<string, unknown>;
  raw_summary: string | null;
  raw_description: string | null;
  raw_location: string | null;
  is_reservation: boolean;
  destination_id: string | null;
  destination_code: string | null;
  destination_source: 'CORRECTED' | 'CALENDAR' | 'UNKNOWN';
  passengers: number | null;
  passengers_source: 'CORRECTED' | 'CALENDAR' | 'UNKNOWN';
  checked_bags: number | null;
  assignment: 'UNFILLED' | 'ASSIGNED' | 'ASSIGNED_UNKNOWN' | 'NOT_A_RESERVATION';
  assigned_driver_id: string | null;
  assignment_source: 'CORRECTED' | 'CALENDAR';
  corrected_payout_cents: number | null;
  calendar_payout_cents: number | null;
  congestion: 'YES' | 'NO' | 'UNKNOWN';
  congestion_source: 'CORRECTED' | 'CALENDAR' | 'UNKNOWN';
  corrected_duration_minutes: number | null;
  correction_notes: string | null;
  correction_version: number | null;
}

export interface SyncStatus {
  connection: {
    status: 'CONNECTED' | 'EXPIRED' | 'ERROR' | 'DISCONNECTED';
    account: string | null;
    calendar_id: string | null;
    calendar_name: string | null;
    last_success_at: string | null;
    last_error: string | null;
  } | null;
  last_run: {
    id: string;
    status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
    started_at: string;
    finished_at: string | null;
    events_seen: number;
    inserted: number;
    updated: number;
    unchanged: number;
    removed: number;
    error: string | null;
  } | null;
  stale: boolean;
  running: boolean;
}

export interface AuditRow {
  id: number;
  actor_id: string | null;
  actor_role: string | null;
  action: string;
  entity_table: string;
  entity_id: string | null;
  affected_driver_id: string | null;
  reason: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  created_at: string;
}
