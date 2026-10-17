// Typed data access. Reads go through RLS-protected tables; every write is an RPC.
import { addDays, localToInstant } from '@handy/core';
import type { LocalDate } from '@handy/core';
import { supabase, SUPABASE_URL } from './supabase';
import { AppError, toAppError, unwrap } from './errors';
import type {
  AdminUnavailabilityRow, AppSettingsRow, AuditRow, BlockRow, ChangeRequestRow, DestinationDefaultRow, DestinationRow,
  ExceptionRow, ProfileRow, PublicSettings, ReservationEffectiveRow, RuleRow, SyncStatus, TemplateRow, TimeOffRow, VehicleRow,
} from './types';

export type SaveResult = { result: 'SAVED' | 'PENDING_APPROVAL'; block_id?: string; request_id?: string; version?: number };

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const res = await supabase.rpc(fn, args ?? {});
  return unwrap(res) as T;
}

// ---------------------------------------------------------------- session
export async function fetchMyAccount(userId: string): Promise<{ profile: ProfileRow | null; isAdmin: boolean }> {
  const [p, r] = await Promise.all([
    supabase.from('driver_profiles').select('*').eq('user_id', userId).maybeSingle(),
    supabase.from('user_roles').select('role').eq('user_id', userId).maybeSingle(),
  ]);
  return { profile: unwrap(p) as ProfileRow | null, isAdmin: (unwrap(r) as { role: string } | null)?.role === 'ADMIN' };
}

export const getPublicSettings = () => rpc<PublicSettings | null>('get_public_settings');

// ---------------------------------------------------------------- profile, vehicles, rates
export const updateMyProfile = (p: { fullName: string; phone: string | null; driverNotes: string | null; version: number }) =>
  rpc<ProfileRow>('update_my_profile', { p_full_name: p.fullName, p_phone: p.phone, p_driver_notes: p.driverNotes, p_expected_version: p.version });

export const completeOnboarding = () => rpc<void>('complete_onboarding');

export async function listVehicles(driverId: string, includeArchived = false): Promise<VehicleRow[]> {
  let q = supabase.from('vehicles').select('*').eq('driver_id', driverId).order('is_default', { ascending: false }).order('name');
  if (!includeArchived) q = q.is('deleted_at', null);
  return unwrap(await q) as VehicleRow[];
}

export const saveVehicle = (v: Partial<VehicleRow>, id?: string, version?: number) =>
  rpc<string>('save_vehicle', {
    p_vehicle: {
      name: v.name, make_model: v.make_model, vehicle_type: v.vehicle_type, max_passengers: v.max_passengers,
      max_luggage: v.max_luggage, accessibility_notes: v.accessibility_notes, is_active: v.is_active ?? true, is_default: v.is_default ?? false,
    },
    p_vehicle_id: id ?? null,
    p_expected_version: version ?? null,
  });

export const archiveVehicle = (id: string, version: number) => rpc<void>('archive_vehicle', { p_vehicle_id: id, p_expected_version: version });

export async function listDestinations(includeInactive = false): Promise<DestinationRow[]> {
  let q = supabase.from('destinations').select('*').order('sort_order').order('name');
  if (!includeInactive) q = q.eq('is_active', true);
  return unwrap(await q) as DestinationRow[];
}

export async function listDestinationDefaults(driverId: string): Promise<DestinationDefaultRow[]> {
  return unwrap(await supabase.from('driver_destination_defaults').select('*').eq('driver_id', driverId)) as DestinationDefaultRow[];
}

export const saveDestinationDefaults = (items: { destination_id: string; accepted: boolean; min_rate_cents: number | null }[]) =>
  rpc<void>('save_destination_defaults', { p_items: items });

// ---------------------------------------------------------------- availability
const BLOCK_SELECT = '*, availability_block_destinations(destination_id, min_rate_cents)';
const RULE_SELECT = '*, availability_rule_destinations(destination_id, min_rate_cents)';

export interface ScheduleRows {
  blocks: BlockRow[];
  rules: RuleRow[];
  exceptions: ExceptionRow[];
  timeOff: TimeOffRow[];
  adminUnavailable: AdminUnavailabilityRow[];
}

/** Everything needed to draw availability for one driver (or all drivers when driverId is null; admins only). */
export async function fetchScheduleRows(driverId: string | null, from: LocalDate, to: LocalDate): Promise<ScheduleRows> {
  const startIso = new Date(localToInstant(addDays(from, -1), '00:00')).toISOString();
  const endIso = new Date(localToInstant(addDays(to, 1), '00:00')).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byDriver = (q: any) => (driverId ? q.eq('driver_id', driverId) : q);

  const [blocks, rules, timeOff, adminU] = await Promise.all([
    byDriver(supabase.from('availability_blocks').select(BLOCK_SELECT).is('deleted_at', null).lt('start_at', endIso).gt('end_at', startIso)).limit(5000),
    byDriver(supabase.from('availability_rules').select(RULE_SELECT).is('deleted_at', null).lte('effective_from', to)
      .or(`effective_until.is.null,effective_until.gte.${addDays(from, -1)}`)).limit(2000),
    byDriver(supabase.from('time_off').select('*').is('deleted_at', null).lte('start_date', to).gte('end_date', from)).limit(2000),
    byDriver(supabase.from('admin_unavailability').select('*').is('deleted_at', null).lt('start_at', endIso).gt('end_at', startIso)).limit(2000),
  ]);
  const ruleRows = unwrap(rules) as RuleRow[];
  const ruleIds = ruleRows.map((r) => r.id);
  const exceptions = ruleIds.length
    ? (unwrap(await supabase.from('rule_exceptions').select('rule_id, occurrence_date').in('rule_id', ruleIds)
        .gte('occurrence_date', addDays(from, -1)).lte('occurrence_date', to)) as ExceptionRow[])
    : [];
  return {
    blocks: unwrap(blocks) as BlockRow[],
    rules: ruleRows,
    exceptions,
    timeOff: unwrap(timeOff) as TimeOffRow[],
    adminUnavailable: unwrap(adminU) as AdminUnavailabilityRow[],
  };
}

export const saveBlock = (payload: Record<string, unknown>, blockId?: string, version?: number, message?: string) =>
  rpc<SaveResult>('save_block', { p_block: payload, p_block_id: blockId ?? null, p_expected_version: version ?? null, p_message: message ?? null });

export const deleteBlock = (blockId: string, version: number, message?: string) =>
  rpc<SaveResult>('delete_block', { p_block_id: blockId, p_expected_version: version, p_message: message ?? null });

export const saveBlocksBatch = (blocks: Record<string, unknown>[], origin: 'COPY' | 'TEMPLATE' | 'DRIVER') =>
  rpc<{ inserted: number; skipped: number; pending: number }>('save_blocks_batch', { p_blocks: blocks, p_origin: origin, p_skip_overlaps: true });

export async function listRules(driverId: string): Promise<RuleRow[]> {
  return unwrap(await supabase.from('availability_rules').select(RULE_SELECT).eq('driver_id', driverId).is('deleted_at', null)
    .order('effective_from', { ascending: false })) as RuleRow[];
}

export const saveRule = (payload: Record<string, unknown>, ruleId?: string, version?: number) =>
  rpc<{ result: 'SAVED'; rule_id: string; effective_from: string; kept_until?: string }>('save_rule', {
    p_rule: payload, p_rule_id: ruleId ?? null, p_expected_version: version ?? null,
  });

export const endRule = (ruleId: string, version: number) => rpc<{ result: 'SAVED'; kept_until: string | null }>('end_rule', { p_rule_id: ruleId, p_expected_version: version });
export const skipOccurrence = (ruleId: string, date: string, message?: string) =>
  rpc<SaveResult>('skip_occurrence', { p_rule_id: ruleId, p_date: date, p_message: message ?? null });
export const restoreOccurrence = (ruleId: string, date: string) => rpc<SaveResult>('restore_occurrence', { p_rule_id: ruleId, p_date: date });
export const clearRange = (from: string, to: string, includeRecurring: boolean) =>
  rpc<{ deleted: number; skipped_occurrences: number; pending: number }>('clear_range', { p_from: from, p_to: to, p_include_recurring: includeRecurring });

export async function listTimeOff(driverId: string): Promise<TimeOffRow[]> {
  return unwrap(await supabase.from('time_off').select('*').eq('driver_id', driverId).is('deleted_at', null).order('start_date', { ascending: false })) as TimeOffRow[];
}
export const saveTimeOff = (start: string, end: string, note: string | null) =>
  rpc<SaveResult>('save_time_off', { p_start: start, p_end: end, p_note: note });
export const deleteTimeOff = (id: string, version: number) => rpc<SaveResult>('delete_time_off', { p_id: id, p_expected_version: version });

export async function listTemplates(driverId: string): Promise<TemplateRow[]> {
  return unwrap(await supabase.from('schedule_templates').select('id, name, span, blocks').eq('driver_id', driverId).order('name')) as TemplateRow[];
}
export const saveTemplate = (name: string, span: 'DAY' | 'WEEK', blocks: unknown[], id?: string) =>
  rpc<string>('save_template', { p_name: name, p_span: span, p_blocks: blocks, p_template_id: id ?? null });
export const deleteTemplate = (id: string) => rpc<void>('delete_template', { p_template_id: id });

export async function listMyChangeRequests(driverId: string): Promise<ChangeRequestRow[]> {
  return unwrap(await supabase.from('change_requests').select('*').eq('driver_id', driverId).order('created_at', { ascending: false }).limit(50)) as ChangeRequestRow[];
}
export const withdrawChangeRequest = (id: string) => rpc<void>('withdraw_change_request', { p_request_id: id });
export const myAdminChanges = () => rpc<AuditRow[]>('my_admin_changes', { p_limit: 50 });

export async function listNotificationPrefs(userId: string): Promise<{ category: string; enabled: boolean }[]> {
  return unwrap(await supabase.from('notification_preferences').select('category, enabled').eq('user_id', userId)) as { category: string; enabled: boolean }[];
}
export async function listNotificationCategories(): Promise<{ code: string; description: string; enabled_globally: boolean; default_on: boolean; version: number }[]> {
  return unwrap(await supabase.from('notification_categories').select('code, description, enabled_globally, default_on, version').order('code')) as never;
}
export const setNotificationPref = (category: string, enabled: boolean) =>
  rpc<void>('set_notification_preference', { p_category: category, p_enabled: enabled });

// ---------------------------------------------------------------- admin
export async function listDrivers(): Promise<ProfileRow[]> {
  return unwrap(await supabase.from('driver_profiles').select('*').order('full_name')) as ProfileRow[];
}
export async function listAllVehicles(): Promise<VehicleRow[]> {
  return unwrap(await supabase.from('vehicles').select('*').is('deleted_at', null)) as VehicleRow[];
}
export async function listAllDestinationDefaults(): Promise<DestinationDefaultRow[]> {
  return unwrap(await supabase.from('driver_destination_defaults').select('*')) as DestinationDefaultRow[];
}
export const setDriverStatus = (driverId: string, status: 'APPROVED' | 'REJECTED' | 'SUSPENDED', reason?: string) =>
  rpc<ProfileRow>('set_driver_status', { p_driver: driverId, p_status: status, p_reason: reason ?? null });
export const adminSaveBlock = (driverId: string, payload: Record<string, unknown>, reason: string, blockId?: string, version?: number) =>
  rpc<SaveResult>('admin_save_block', { p_driver: driverId, p_block: payload, p_block_id: blockId ?? null, p_expected_version: version ?? null, p_reason: reason });
export const adminDeleteBlock = (blockId: string, version: number, reason: string) =>
  rpc<SaveResult>('admin_delete_block', { p_block_id: blockId, p_expected_version: version, p_reason: reason });
export const adminMarkUnavailable = (driverId: string, start: number, end: number, reason: string) =>
  rpc<string>('admin_mark_unavailable', { p_driver: driverId, p_start: new Date(start).toISOString(), p_end: new Date(end).toISOString(), p_reason: reason });
export const adminClearUnavailable = (id: string, reason?: string) => rpc<void>('admin_clear_unavailable', { p_id: id, p_reason: reason ?? null });

export async function listPendingChangeRequests(): Promise<ChangeRequestRow[]> {
  return unwrap(await supabase.from('change_requests').select('*').eq('status', 'PENDING').order('created_at')) as ChangeRequestRow[];
}
export const decideChangeRequest = (id: string, approve: boolean, reason?: string) =>
  rpc<{ result: string }>('decide_change_request', { p_request_id: id, p_approve: approve, p_reason: reason ?? null });

export async function getSettings(): Promise<AppSettingsRow> {
  return unwrap(await supabase.from('app_settings').select('*').eq('id', 1).single()) as AppSettingsRow;
}
export async function updateSettings(patch: Partial<AppSettingsRow>, version: number): Promise<AppSettingsRow> {
  const res = await supabase.from('app_settings').update(patch).eq('id', 1).eq('version', version).select('*');
  const rows = unwrap(res) as AppSettingsRow[];
  if (rows.length === 0) throw new AppError('CONFLICT', 'Settings changed in another window. Reload and try again.');
  return rows[0];
}
export async function saveDestination(d: Partial<DestinationRow>, id?: string, version?: number): Promise<void> {
  const fields = {
    code: d.code, name: d.name, kind: d.kind, preset_payout_cents: d.preset_payout_cents, est_duration_minutes: d.est_duration_minutes,
    congestion_eligible: d.congestion_eligible, sort_order: d.sort_order, is_active: d.is_active,
  };
  if (!id) {
    unwrap(await supabase.from('destinations').insert(fields).select('id'));
    return;
  }
  const rows = unwrap(await supabase.from('destinations').update(fields).eq('id', id).eq('version', version ?? -1).select('id')) as unknown[];
  if (rows.length === 0) throw new AppError('CONFLICT', 'This destination changed in another window. Reload and try again.');
}

export async function listReservations(from: string, to: string, opts: { includeRemoved?: boolean } = {}): Promise<ReservationEffectiveRow[]> {
  let q = supabase.from('reservations_effective').select('*').gte('pickup_at', from).lt('pickup_at', to).order('pickup_at').limit(3000);
  if (!opts.includeRemoved) q = q.eq('removed_from_source', false);
  return unwrap(await q) as ReservationEffectiveRow[];
}
export async function getReservation(id: string): Promise<ReservationEffectiveRow> {
  return unwrap(await supabase.from('reservations_effective').select('*').eq('id', id).single()) as ReservationEffectiveRow;
}
export async function saveReservationCorrection(reservationId: string, fields: Record<string, unknown>, version: number | null): Promise<void> {
  if (version === null) {
    unwrap(await supabase.from('reservation_corrections').insert({ reservation_id: reservationId, ...fields }).select('reservation_id'));
    return;
  }
  const rows = unwrap(await supabase.from('reservation_corrections').update(fields).eq('reservation_id', reservationId).eq('version', version).select('reservation_id')) as unknown[];
  if (rows.length === 0) throw new AppError('CONFLICT', 'This correction changed in another window. Reload and try again.');
}
export async function clearReservationCorrection(reservationId: string): Promise<void> {
  unwrap(await supabase.from('reservation_corrections').delete().eq('reservation_id', reservationId));
}

export async function listOverrides(reservationId: string): Promise<{ id: string; driver_id: string; reason: string; created_by: string; created_at: string }[]> {
  return unwrap(await supabase.from('eligibility_overrides').select('id, driver_id, reason, created_by, created_at').eq('reservation_id', reservationId).is('revoked_at', null)) as never;
}
export const setOverride = (reservationId: string, driverId: string, reason: string) =>
  rpc<string>('set_eligibility_override', { p_reservation: reservationId, p_driver: driverId, p_reason: reason });
export const revokeOverride = (id: string) => rpc<void>('revoke_eligibility_override', { p_override_id: id });

export const syncStatus = () => rpc<SyncStatus | null>('admin_sync_status');
export const setCalendar = (id: string, name: string) => rpc<void>('admin_set_calendar', { p_calendar_id: id, p_calendar_name: name });
export const disconnectCalendar = () => rpc<void>('admin_disconnect_calendar');

export async function listAudit(filter: { driverId?: string; table?: string; limit?: number; before?: number }): Promise<AuditRow[]> {
  let q = supabase.from('audit_log').select('*').order('id', { ascending: false }).limit(filter.limit ?? 100);
  if (filter.driverId) q = q.eq('affected_driver_id', filter.driverId);
  if (filter.table) q = q.eq('entity_table', filter.table);
  if (filter.before) q = q.lt('id', filter.before);
  return unwrap(await q) as AuditRow[];
}

export async function listAdminNotes(driverId: string): Promise<{ id: string; body: string; created_at: string; author_id: string | null }[]> {
  return unwrap(await supabase.from('admin_driver_notes').select('id, body, created_at, author_id').eq('driver_id', driverId).order('created_at', { ascending: false })) as never;
}
export async function addAdminNote(driverId: string, body: string, authorId: string): Promise<void> {
  unwrap(await supabase.from('admin_driver_notes').insert({ driver_id: driverId, body, author_id: authorId }).select('id'));
}

export async function listAliases(): Promise<{ id: string; driver_id: string; alias: string }[]> {
  return unwrap(await supabase.from('driver_aliases').select('id, driver_id, alias').order('alias')) as never;
}
export async function addAlias(driverId: string, alias: string): Promise<void> {
  unwrap(await supabase.from('driver_aliases').insert({ driver_id: driverId, alias }).select('id'));
}
export async function deleteAlias(id: string): Promise<void> {
  unwrap(await supabase.from('driver_aliases').delete().eq('id', id));
}

export async function listParsingConfig() {
  const [rules, rates, markers] = await Promise.all([
    supabase.from('parsing_rules').select('*').order('field').order('priority'),
    supabase.from('rate_mappings').select('*').order('priority'),
    supabase.from('reservation_markers').select('*'),
  ]);
  return {
    rules: unwrap(rules) as { id: string; field: string; source: string; pattern: string; priority: number; enabled: boolean; version: number }[],
    rates: unwrap(rates) as { id: string; pattern: string; destination_code: string; congestion: 'YES' | 'NO' | 'UNKNOWN' | null; priority: number; version: number }[],
    markers: unwrap(markers) as { id: string; source: string; pattern: string; enabled: boolean }[],
  };
}
export async function upsertRateMapping(m: { id?: string; pattern: string; destination_code: string; congestion: string | null; priority: number }) {
  if (m.id) unwrap(await supabase.from('rate_mappings').update({ pattern: m.pattern, destination_code: m.destination_code, congestion: m.congestion, priority: m.priority }).eq('id', m.id).select('id'));
  else unwrap(await supabase.from('rate_mappings').insert({ pattern: m.pattern, destination_code: m.destination_code, congestion: m.congestion, priority: m.priority }).select('id'));
}
export async function deleteRateMapping(id: string) { unwrap(await supabase.from('rate_mappings').delete().eq('id', id)); }
export async function upsertParsingRule(r: { id?: string; field: string; source: string; pattern: string; priority: number; enabled: boolean }) {
  const f = { field: r.field, source: r.source, pattern: r.pattern, priority: r.priority, enabled: r.enabled };
  if (r.id) unwrap(await supabase.from('parsing_rules').update(f).eq('id', r.id).select('id'));
  else unwrap(await supabase.from('parsing_rules').insert(f).select('id'));
}
export async function deleteParsingRule(id: string) { unwrap(await supabase.from('parsing_rules').delete().eq('id', id)); }

// ---------------------------------------------------------------- Edge Functions (admin)
async function callFunction<T>(name: string, body: unknown = {}): Promise<T> {
  const { data: s } = await supabase.auth.getSession();
  const token = s.session?.access_token;
  if (!token) throw new AppError('AUTH', 'Please log in again.');
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw toAppError(e);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) throw new AppError(data.error ?? 'FUNCTION_ERROR', data.message ?? `Request failed (${res.status}).`);
  return data as T;
}

export const startGoogleConnect = () => callFunction<{ url: string }>('google-oauth-start');
export const listGoogleCalendars = () => callFunction<{ calendars: { id: string; summary: string; primary: boolean; accessRole: string }[] }>('google-calendars');
export const runCalendarSync = () => callFunction<{ ok: true; events: number; inserted: number; updated: number; unchanged: number; removed: number }>('calendar-sync');
export const sendRemindersNow = () => callFunction<{ ok: true; sent: number; failed: number; deferred: number; skipped?: string }>('send-notifications', { force: true });
