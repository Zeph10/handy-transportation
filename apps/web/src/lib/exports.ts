// Shape data for exports. Pure (unit-tested); file generation lives in the Exports page.
import { addDays, eachDate, formatUSD, instantToLocalDate, instantToLocalTime, localToInstant } from '../../../../core/src/index.ts';
import type { LocalDate } from '../../../../core/src/index.ts';
import { driverTimeline, effectiveDuration, reservationPayout } from './matchInputs.ts';
import type { AdminDataset } from './matchInputs.ts';

export const AVAILABILITY_COLUMNS = ['Driver', 'Date', 'Start', 'End', 'Status', 'Source', 'Vehicle', 'Seats', 'Large bags', 'Destinations (minimum)'] as const;

export function availabilityRows(ds: AdminDataset, from: LocalDate, to: LocalDate, driverIds?: string[]): string[][] {
  const rows: string[][] = [];
  const start = localToInstant(from, '00:00');
  const end = localToInstant(addDays(to, 1), '00:00');
  const drivers = ds.drivers.filter((d) => d.status === 'APPROVED' && (!driverIds || driverIds.includes(d.user_id)))
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
  for (const d of drivers) {
    const tl = driverTimeline(ds.schedules.get(d.user_id), start, end).filter((s) => s.end > start && s.start < end && s.status !== 'UNKNOWN');
    for (const s of tl) {
      const segStart = Math.max(s.start, start);
      const segEnd = Math.min(s.end, end);
      const v = ds.vehicles.find((x) => x.id === s.vehicleId);
      const source = s.source.kind === 'RULE' ? 'Weekly schedule' : s.source.kind === 'BLOCK' ? 'One-off' : s.source.kind === 'TIME_OFF' ? 'Time off' : 'Marked unavailable by admin';
      const dests = s.destinations.map((o) => {
        const dest = ds.destinations.find((x) => x.id === o.destinationId);
        const min = o.minRateCents ?? ds.defaults.find((x) => x.driver_id === d.user_id && x.destination_id === o.destinationId)?.min_rate_cents ?? dest?.preset_payout_cents ?? 0;
        return `${dest?.code ?? '?'} (${formatUSD(min)})`;
      }).join(', ');
      rows.push([
        d.full_name || d.email, instantToLocalDate(segStart), instantToLocalTime(segStart),
        instantToLocalDate(segEnd) !== instantToLocalDate(segStart) ? `${instantToLocalTime(segEnd)} (+1 day)` : instantToLocalTime(segEnd),
        s.status, source, v?.name ?? '', v ? String(v.max_passengers) : '', v?.max_luggage != null ? String(v.max_luggage) : '', dests,
      ]);
    }
  }
  return rows;
}

/** Weekly master grid: one row per driver, one column per day, cells list available times. */
export function masterScheduleGrid(ds: AdminDataset, monday: LocalDate): { header: string[]; rows: string[][] } {
  const days = eachDate(monday, addDays(monday, 6));
  const header = ['Driver', ...days.map((d) => d)];
  const rows = ds.drivers.filter((d) => d.status === 'APPROVED').sort((a, b) => a.full_name.localeCompare(b.full_name)).map((d) => {
    const cells = days.map((day) => {
      const s0 = localToInstant(day, '00:00');
      const s1 = localToInstant(addDays(day, 1), '00:00');
      return driverTimeline(ds.schedules.get(d.user_id), s0, s1)
        .filter((s) => s.end > s0 && s.start < s1 && (s.status === 'AVAILABLE' || s.status === 'TENTATIVE'))
        .map((s) => `${instantToLocalTime(Math.max(s.start, s0))}-${s.end >= s1 ? '24:00' : instantToLocalTime(s.end)}${s.status === 'TENTATIVE' ? ' (T)' : ''}`)
        .join(', ') || '—';
    });
    return [d.full_name || d.email, ...cells];
  });
  return { header, rows };
}

export const ASSIGNMENT_COLUMNS = ['Pickup', 'Trip', 'Destination', 'Passengers', 'Assigned driver', 'Assignment source', 'Base payout', 'Payout source', 'Congestion', 'Total', 'Est. duration (min)'] as const;

/** Reservations with assignment information exactly as known (calendar or admin correction); nothing inferred. */
export function assignmentRows(ds: AdminDataset, from: LocalDate, to: LocalDate): string[][] {
  const start = localToInstant(from, '00:00');
  const end = localToInstant(addDays(to, 1), '00:00');
  return ds.reservations
    .filter((r) => r.is_reservation && !r.removed_from_source && r.pickup_at && Date.parse(r.pickup_at) >= start && Date.parse(r.pickup_at) < end)
    .sort((a, b) => Date.parse(a.pickup_at!) - Date.parse(b.pickup_at!))
    .map((r) => {
      const p = reservationPayout(r, ds);
      const driver = r.assignment === 'ASSIGNED' ? ds.drivers.find((d) => d.user_id === r.assigned_driver_id)?.full_name ?? '' : '';
      return [
        `${instantToLocalDate(Date.parse(r.pickup_at!))} ${instantToLocalTime(Date.parse(r.pickup_at!))}`,
        r.trip_ref ?? '', r.destination_code ?? 'UNKNOWN', r.passengers == null ? 'UNKNOWN' : String(r.passengers),
        r.assignment === 'UNFILLED' ? 'UNFILLED' : r.assignment === 'ASSIGNED_UNKNOWN' ? 'Unmatched name' : driver,
        r.assignment === 'ASSIGNED' || r.assignment === 'UNFILLED' ? (r.assignment_source === 'CORRECTED' ? 'Admin' : 'Google Calendar') : '',
        p.baseCents == null ? 'UNKNOWN' : formatUSD(p.baseCents),
        p.baseSource === 'ASSUMED_PRESET' ? 'Company preset (assumed)' : p.baseSource === 'CORRECTED' ? 'Admin' : p.baseSource === 'CALENDAR' ? 'Google Calendar' : 'Unknown',
        p.congestion === 'YES' ? `+${formatUSD(p.congestionCents)}` : p.congestion === 'NO' ? 'No' : 'Not determined',
        p.totalCents == null ? 'UNKNOWN' : formatUSD(p.totalCents),
        String(effectiveDuration(r, ds.destinations).minutes ?? ''),
      ];
    });
}

export const RATE_COLUMNS = ['Driver', 'Destination', 'Accepted', 'Usual minimum', 'Company payout'] as const;

export function driverRateRows(ds: AdminDataset): string[][] {
  const rows: string[][] = [];
  for (const d of ds.drivers.filter((x) => x.status === 'APPROVED').sort((a, b) => a.full_name.localeCompare(b.full_name))) {
    for (const dest of ds.destinations) {
      const def = ds.defaults.find((x) => x.driver_id === d.user_id && x.destination_id === dest.id);
      rows.push([d.full_name || d.email, dest.code, def?.accepted ? 'Yes' : 'No', def?.min_rate_cents != null ? formatUSD(def.min_rate_cents) : '', dest.preset_payout_cents ? formatUSD(dest.preset_payout_cents) : 'varies']);
    }
  }
  return rows;
}

/** RFC 4180 CSV with a BOM so Excel opens UTF-8 correctly. */
export function toCsv(header: readonly string[], rows: string[][]): string {
  const esc = (v: string) => (/[",\r\n]/.test(v) || /^[=+\-@]/.test(v) ? `"${(/^[=+\-@]/.test(v) ? "'" : '') + v.replace(/"/g, '""')}"` : v);
  return '﻿' + [header, ...rows].map((r) => r.map((c) => esc(String(c ?? ''))).join(',')).join('\r\n') + '\r\n';
}
