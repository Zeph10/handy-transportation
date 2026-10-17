import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignmentRows, availabilityRows, masterScheduleGrid, toCsv } from '../src/lib/exports.ts';
import { scheduleFromRows } from '../src/lib/convert.ts';
import type { AdminDataset } from '../src/lib/matchInputs.ts';

const NYC = { id: 'nyc', code: 'NYC', name: 'NYC', kind: 'CITY' as const, preset_payout_cents: 16000, est_duration_minutes: 75, congestion_eligible: true, sort_order: 40, is_active: true, version: 1 };
const settings = { id: 1 as const, environment: 'production' as const, congestion_surcharge_cents: 900, short_notice_window_hours: 24, submission_deadline_dow: 4, submission_deadline_time: '18:00', travel_to_pickup_minutes: 60, post_trip_buffer_minutes: 30, require_approval: true, assume_preset_when_payout_missing: true, sync_window_past_days: 30, sync_window_future_days: 180, stale_after_hours: 24, reminder_enabled: true, reminder_dow: 3, reminder_time: '10:00', version: 1 };
const ds: AdminDataset = {
  settings, destinations: [NYC],
  drivers: [{ user_id: 'a', full_name: 'Ava', email: 'a@x', phone: null, status: 'APPROVED', status_reason: null, driver_notes: null, onboarding_completed: true, created_at: '', updated_at: '', version: 1 }],
  vehicles: [{ id: 'v', driver_id: 'a', name: 'SUV', make_model: null, vehicle_type: 'SUV', max_passengers: 6, max_luggage: 5, accessibility_notes: null, is_active: true, is_default: true, deleted_at: null, version: 1 }],
  defaults: [{ driver_id: 'a', destination_id: 'nyc', accepted: true, min_rate_cents: 15000 }],
  schedules: new Map([['a', scheduleFromRows({ rules: [], exceptions: [], timeOff: [], adminUnavailable: [], blocks: [
    { id: 'b', driver_id: 'a', start_at: '2026-10-23T00:00:00Z', end_at: '2026-10-23T08:00:00Z', status: 'AVAILABLE', vehicle_id: 'v', notes: null, rule_id: null, occurrence_date: null, origin: 'DRIVER', version: 1, availability_block_destinations: [{ destination_id: 'nyc', min_rate_cents: null }] },
  ] })]]),
  reservations: [{ id: 'r', google_event_id: 'g', trip_ref: 'TRP-1', pickup_at: '2026-10-21T19:00:00Z', event_end_at: null, all_day: false, source_status: 'confirmed', removed_from_source: false, last_synced_at: '', review_flags: [], parsed: {}, raw_summary: null, raw_description: null, raw_location: null, is_reservation: true, destination_id: 'nyc', destination_code: 'NYC', destination_source: 'CALENDAR', passengers: 1, passengers_source: 'CALENDAR', checked_bags: 0, assignment: 'UNFILLED', assigned_driver_id: null, assignment_source: 'CALENDAR', corrected_payout_cents: null, calendar_payout_cents: null, congestion: 'YES', congestion_source: 'CALENDAR', corrected_duration_minutes: null, correction_notes: null, correction_version: null }],
  overrides: [],
};

test('availability export lists real segments, overnight marked, minimum resolved from profile', () => {
  const rows = availabilityRows(ds, '2026-10-19', '2026-10-25');
  assert.deepEqual(rows, [['Ava', '2026-10-22', '20:00', '04:00 (+1 day)', 'AVAILABLE', 'One-off', 'SUV', '6', '5', 'NYC ($150)']]);
});

test('master grid splits overnight availability across days', () => {
  const g = masterScheduleGrid(ds, '2026-10-19');
  assert.equal(g.rows[0][4], '20:00-24:00'); // Thu
  assert.equal(g.rows[0][5], '00:00-04:00'); // Fri
  assert.equal(g.rows[0][1], '—');
});

test('assignment export shows only known assignments and separates congestion', () => {
  const rows = assignmentRows(ds, '2026-10-21', '2026-10-21');
  assert.deepEqual(rows[0].slice(0, 10), ['2026-10-21 15:00', 'TRP-1', 'NYC', '1', 'UNFILLED', 'Google Calendar', '$160', 'Company preset (assumed)', '+$9', '$169']);
});

test('CSV escapes quotes, commas and spreadsheet formulas', () => {
  const csv = toCsv(['a', 'b'], [['x,y', '=SUM(1)'], ['he said "hi"', 'ok']]);
  assert.equal(csv, '﻿a,b\r\n"x,y","\'=SUM(1)"\r\n"he said ""hi""",ok\r\n');
});
