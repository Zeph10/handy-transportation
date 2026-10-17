// Assemble core matching inputs from database rows. Pure (unit-tested with node).
import {
  addDays, instantToLocalDate, matchReservation, payoutBreakdown, requiredWindow, resolveAvailability, localToInstant,
} from '../../../../core/src/index.ts';
import type { MatchDriver, MatchReservation, MatchResult, MatchSettings, PayoutBreakdown, ResolvedSegment } from '../../../../core/src/index.ts';
import type { DriverSchedule } from './convert.ts';
import { occurrencesFor } from './convert.ts';
import type { AppSettingsRow, DestinationDefaultRow, DestinationRow, ProfileRow, ReservationEffectiveRow, VehicleRow } from './types.ts';

export interface AdminDataset {
  settings: AppSettingsRow;
  destinations: DestinationRow[];
  drivers: ProfileRow[];
  vehicles: VehicleRow[];
  defaults: DestinationDefaultRow[];
  /** Per-driver schedules covering at least the dates being matched */
  schedules: Map<string, DriverSchedule>;
  reservations: ReservationEffectiveRow[];
  overrides: { reservation_id: string; driver_id: string; reason: string; created_by: string; created_at: string }[];
}

export function effectiveDuration(r: ReservationEffectiveRow, destinations: DestinationRow[]): { minutes: number | null; estimate: boolean } {
  if (r.corrected_duration_minutes != null) return { minutes: r.corrected_duration_minutes, estimate: false };
  const d = destinations.find((x) => x.id === r.destination_id);
  return { minutes: d?.est_duration_minutes ?? null, estimate: true };
}

export function reservationPayout(r: ReservationEffectiveRow, ds: Pick<AdminDataset, 'settings' | 'destinations'>): PayoutBreakdown {
  const dest = ds.destinations.find((x) => x.id === r.destination_id);
  return payoutBreakdown({
    correctedCents: r.corrected_payout_cents,
    calendarCents: r.calendar_payout_cents,
    presetCents: dest?.preset_payout_cents ?? null,
    assumePresetWhenMissing: ds.settings.assume_preset_when_payout_missing,
    congestion: r.congestion,
    congestionEligible: dest?.congestion_eligible ?? false,
    surchargeCents: ds.settings.congestion_surcharge_cents,
  });
}

export function toMatchReservation(r: ReservationEffectiveRow, ds: AdminDataset): MatchReservation {
  const dur = effectiveDuration(r, ds.destinations);
  return {
    id: r.id,
    pickupAt: r.pickup_at ? Date.parse(r.pickup_at) : null,
    destinationId: r.destination_id,
    destinationCode: r.destination_code,
    passengers: r.passengers,
    checkedBags: r.checked_bags,
    durationMinutes: dur.minutes,
    durationIsEstimate: dur.estimate,
    payout: reservationPayout(r, ds),
  };
}

export function matchSettings(ds: AdminDataset): MatchSettings {
  return {
    travelToPickupMinutes: ds.settings.travel_to_pickup_minutes,
    postTripBufferMinutes: ds.settings.post_trip_buffer_minutes,
    presets: Object.fromEntries(ds.destinations.map((d) => [d.id, d.preset_payout_cents])),
    destinationNames: Object.fromEntries(ds.destinations.map((d) => [d.id, d.name])),
  };
}

/** Resolved timeline for a driver over the local days around an instant window. */
export function driverTimeline(s: DriverSchedule | undefined, start: number, end: number): ResolvedSegment[] {
  const from = addDays(instantToLocalDate(start), -1);
  const to = addDays(instantToLocalDate(end), 1);
  const empty: DriverSchedule = { blocks: [], rules: [], exceptions: [], timeOff: [], adminUnavailable: [] };
  const sch = s ?? empty;
  return resolveAvailability({
    windowStart: localToInstant(from, '00:00'),
    windowEnd: localToInstant(addDays(to, 1), '00:00'),
    timeOff: sch.timeOff,
    blocks: sch.blocks,
    occurrences: occurrencesFor(sch, from, to),
    adminUnavailable: sch.adminUnavailable,
  });
}

export function assignedCommitments(driverId: string, ds: AdminDataset) {
  return ds.reservations
    .filter((r) => r.assignment === 'ASSIGNED' && r.assigned_driver_id === driverId && !r.removed_from_source && r.pickup_at && r.is_reservation)
    .map((r) => ({
      reservationId: r.id,
      label: r.trip_ref ?? 'a reservation',
      pickupAt: Date.parse(r.pickup_at!),
      durationMinutes: effectiveDuration(r, ds.destinations).minutes,
    }));
}

/** Run matching for one reservation across every approved driver. */
export function matchOne(r: ReservationEffectiveRow, ds: AdminDataset): MatchResult {
  const res = toMatchReservation(r, ds);
  const settings = matchSettings(ds);
  const win = res.pickupAt === null ? null : requiredWindow(res.pickupAt, res.durationMinutes, settings);
  const drivers: MatchDriver[] = ds.drivers
    .filter((d) => d.status === 'APPROVED')
    .map((d) => {
      const ov = ds.overrides.find((o) => o.reservation_id === r.id && o.driver_id === d.user_id);
      return {
        driverId: d.user_id,
        name: d.full_name || d.email,
        segments: win ? driverTimeline(ds.schedules.get(d.user_id), win.start, win.end) : [],
        vehicles: ds.vehicles.filter((v) => v.driver_id === d.user_id).map((v) => ({
          id: v.id, name: v.name, maxPassengers: v.max_passengers, maxLuggage: v.max_luggage, isActive: v.is_active,
        })),
        profileMinimums: Object.fromEntries(ds.defaults.filter((x) => x.driver_id === d.user_id).map((x) => [x.destination_id, x.min_rate_cents])),
        assigned: assignedCommitments(d.user_id, ds),
        override: ov ? { reason: ov.reason, createdBy: ov.created_by, createdAt: Date.parse(ov.created_at) } : null,
      };
    });
  return matchReservation(res, drivers, settings);
}

/** Assigned reservations that clash with the driver's availability or with another assignment. */
export function findConflicts(ds: AdminDataset): Map<string, string> {
  const out = new Map<string, string>();
  const settings = matchSettings(ds);
  const byDriver = new Map<string, ReservationEffectiveRow[]>();
  for (const r of ds.reservations) {
    if (r.assignment !== 'ASSIGNED' || !r.assigned_driver_id || !r.pickup_at || r.removed_from_source || !r.is_reservation) continue;
    byDriver.set(r.assigned_driver_id, [...(byDriver.get(r.assigned_driver_id) ?? []), r]);
  }
  for (const [driverId, list] of byDriver) {
    const windows = list.map((r) => ({ r, w: requiredWindow(Date.parse(r.pickup_at!), effectiveDuration(r, ds.destinations).minutes, settings) }));
    for (const { r, w } of windows) {
      const overlapping = windows.find((o) => o.r.id !== r.id && o.w.start < w.end && o.w.end > w.start);
      if (overlapping) { out.set(r.id, `Overlaps ${overlapping.r.trip_ref ?? 'another trip'} for the same driver`); continue; }
      const segs = driverTimeline(ds.schedules.get(driverId), w.start, w.end).filter((s) => s.end > w.start && s.start < w.end);
      if (segs.some((s) => s.status === 'UNAVAILABLE')) out.set(r.id, 'Driver marked unavailable during this trip');
    }
  }
  return out;
}
