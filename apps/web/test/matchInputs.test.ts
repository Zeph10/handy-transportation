import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findConflicts, matchOne, reservationPayout } from '../src/lib/matchInputs.ts';
import type { AdminDataset } from '../src/lib/matchInputs.ts';
import { scheduleFromRows } from '../src/lib/convert.ts';

const NYC = { id: 'nyc', code: 'NYC', name: 'NYC', kind: 'CITY' as const, preset_payout_cents: 16000, est_duration_minutes: 75, congestion_eligible: true, sort_order: 40, is_active: true, version: 1 };
const settings = { id: 1 as const, environment: 'production' as const, congestion_surcharge_cents: 900, short_notice_window_hours: 24, submission_deadline_dow: 4,
  submission_deadline_time: '18:00', travel_to_pickup_minutes: 60, post_trip_buffer_minutes: 30, require_approval: true, assume_preset_when_payout_missing: true,
  sync_window_past_days: 30, sync_window_future_days: 180, stale_after_hours: 24, reminder_enabled: true, reminder_dow: 3, reminder_time: '10:00', version: 1 };
const driver = (id: string, name: string) => ({ user_id: id, full_name: name, email: `${id}@x.test`, phone: null, status: 'APPROVED' as const, status_reason: null, driver_notes: null, onboarding_completed: true, created_at: '', updated_at: '', version: 1 });
const block = (id: string, driverId: string, s: string, e: string) => ({ id, driver_id: driverId, start_at: s, end_at: e, status: 'AVAILABLE' as const, vehicle_id: `veh-${driverId}`, notes: null, rule_id: null, occurrence_date: null, origin: 'DRIVER' as const, version: 1, availability_block_destinations: [{ destination_id: 'nyc', min_rate_cents: null }] });
const empty = { rules: [], exceptions: [], timeOff: [], adminUnavailable: [] };

// Modelled on TRP-04327: Wed 21 Oct 2026, 3:00 PM pickup, NYC, congestion, 1 passenger, unfilled, no payout in calendar.
const trip = {
  id: 'res1', google_event_id: 'g1', trip_ref: 'TRP-04327', pickup_at: '2026-10-21T19:00:00Z', event_end_at: '2026-10-21T20:00:00Z', all_day: false,
  source_status: 'confirmed', removed_from_source: false, last_synced_at: '', review_flags: [], parsed: {}, raw_summary: null, raw_description: null, raw_location: null,
  is_reservation: true, destination_id: 'nyc', destination_code: 'NYC', destination_source: 'CALENDAR' as const, passengers: 1, passengers_source: 'CALENDAR' as const,
  checked_bags: 0, assignment: 'UNFILLED' as const, assigned_driver_id: null, assignment_source: 'CALENDAR' as const, corrected_payout_cents: null,
  calendar_payout_cents: null, congestion: 'YES' as const, congestion_source: 'CALENDAR' as const, corrected_duration_minutes: null, correction_notes: null, correction_version: null,
};

function dataset(): AdminDataset {
  return {
    settings, destinations: [NYC],
    drivers: [driver('a', 'Ava'), driver('b', 'Ben')],
    vehicles: ['a', 'b'].map((d) => ({ id: `veh-${d}`, driver_id: d, name: 'SUV', make_model: null, vehicle_type: 'SUV' as const, max_passengers: 6, max_luggage: 6, accessibility_notes: null, is_active: true, is_default: true, deleted_at: null, version: 1 })),
    defaults: [{ driver_id: 'a', destination_id: 'nyc', accepted: true, min_rate_cents: 16000 }, { driver_id: 'b', destination_id: 'nyc', accepted: true, min_rate_cents: 16000 }],
    schedules: new Map([
      ['a', scheduleFromRows({ ...empty, blocks: [block('ba', 'a', '2026-10-21T16:00:00Z', '2026-10-21T23:00:00Z')] })], // 12–7 PM
      ['b', scheduleFromRows({ ...empty, blocks: [block('bb', 'b', '2026-10-21T16:00:00Z', '2026-10-21T20:00:00Z')] })], // 12–4 PM
    ]),
    reservations: [trip],
    overrides: [],
  };
}

test('TRP-04327 scenario: full chain from rows to match result', () => {
  const ds = dataset();
  const p = reservationPayout(trip, ds);
  assert.deepEqual([p.baseCents, p.baseSource, p.congestionCents, p.totalCents], [16000, 'ASSUMED_PRESET', 900, 16900]);
  const res = matchOne(trip, ds);
  assert.deepEqual(res.eligible.map((x) => x.name), ['Ava']);
  // Ben's block covers the 3:00 PM pickup but ends at 4:00 PM; the trip needs until 4:45 PM.
  assert.deepEqual(res.ineligible.map((x) => x.name), ['Ben']);
  assert.match(res.ineligible[0].reasons[0].message, /Available only until 4:00 PM/);
});

test('an assignment found in the calendar becomes a conflict for that driver', () => {
  const ds = dataset();
  ds.reservations.push({ ...trip, id: 'res2', trip_ref: 'TRP-1', assignment: 'ASSIGNED', assigned_driver_id: 'a', pickup_at: '2026-10-21T20:00:00Z' });
  const res = matchOne(trip, ds);
  assert.equal(res.eligible.length, 0);
  assert.ok(res.ineligible.find((x) => x.name === 'Ava')!.reasons.some((r) => r.code === 'CONFLICT'));
});

test('conflict detection flags overlapping assignments and unavailable drivers', () => {
  const ds = dataset();
  ds.reservations = [
    { ...trip, id: 'x1', trip_ref: 'T1', assignment: 'ASSIGNED', assigned_driver_id: 'a' },
    { ...trip, id: 'x2', trip_ref: 'T2', assignment: 'ASSIGNED', assigned_driver_id: 'a', pickup_at: '2026-10-21T19:30:00Z' },
  ];
  const c = findConflicts(ds);
  assert.ok(c.get('x1')?.startsWith('Overlaps T2'));
  assert.ok(c.get('x2')?.startsWith('Overlaps T1'));
});

test('admin override is visible and never a normal match', () => {
  const ds = dataset();
  ds.overrides = [{ reservation_id: 'res1', driver_id: 'b', reason: 'Confirmed by phone', created_by: 'admin', created_at: '2026-10-20T00:00:00Z' }];
  const res = matchOne(trip, ds);
  assert.deepEqual(res.overridden.map((x) => x.name), ['Ben']);
  assert.equal(res.overridden[0].override?.reason, 'Confirmed by phone');
});
