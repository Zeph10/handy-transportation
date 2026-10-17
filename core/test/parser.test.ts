import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultParserConfig, parseReservation, validatePattern, DEFAULT_RULES } from '../src/parser.ts';
import type { DriverDirectoryEntry } from '../src/parser.ts';
import { assignedEwrWithNotes, assignedJfk, internalNote, unfilledNycCongestion } from './fixtures/events.ts';

const drivers: DriverDirectoryEntry[] = [
  { driverId: 'drv-dana', fullName: 'Dana Driver', email: 'dana.driver@example.com', aliases: [] },
  { driverId: 'drv-chris', fullName: 'Christopher Owner', email: 'chris@example.com', aliases: ['Chris Owner'] },
];
const config = defaultParserConfig(drivers);

test('unfilled NYC congestion trip (TRP-04327 format) parses completely', () => {
  const r = parseReservation(unfilledNycCongestion, config);
  assert.equal(r.isReservation, true);
  assert.equal(r.tripRef, 'TRP-90001');
  assert.equal(r.tripStatus, 'confirmed');
  assert.equal(r.assignment, 'UNFILLED');
  assert.equal(r.assignedDriverId, null);
  assert.equal(r.destinationCode, 'NYC');
  assert.equal(r.congestion, 'YES');
  assert.equal(r.passengers, 1);
  assert.equal(r.checkedBags, 0);
  assert.equal(r.carryOnBags, 0);
  assert.equal(r.flight, null);
  assert.equal(r.pickupAddress, 'Example Law @ 1 Example Plaza, NYC');
  assert.equal(r.dropoffAddress, '10 Sample Ridge, Oakland, NJ');
  assert.equal(new Date(r.pickupAt!).toISOString(), '2026-10-21T19:00:00.000Z');
  assert.equal(r.payoutCents, null);
  assert.deepEqual(r.unknownFields, ['payout']);
  assert.ok(!r.reviewFlags.includes('PICKUP_TIME_MISMATCH'));
  assert.ok(!r.reviewFlags.includes('MISSING_DESTINATION'));
});

test('assigned trip matches driver by name and keeps special instructions', () => {
  const r = parseReservation(assignedJfk, config);
  assert.equal(r.assignment, 'ASSIGNED');
  assert.equal(r.assignedDriverId, 'drv-dana');
  assert.equal(r.driverName, 'Dana Driver');
  assert.equal(r.destinationCode, 'JFK');
  assert.equal(r.congestion, 'UNKNOWN');
  assert.equal(r.passengers, 4);
  assert.equal(r.checkedBags, 5);
  assert.equal(r.carryOnBags, 2);
  assert.equal(r.flight, 'QR701 - INTERNATIONAL');
  assert.equal(r.vehicle, 'Black Suburban (TEST001)');
  assert.match(r.specialInstructions ?? '', /CAR SEATS: 1 convertible/);
  assert.deepEqual(r.reviewFlags, []);
});

test('driver alias matching and customer notes', () => {
  const r = parseReservation(assignedEwrWithNotes, config);
  assert.equal(r.assignment, 'ASSIGNED');
  assert.equal(r.assignedDriverId, 'drv-chris');
  assert.equal(r.destinationCode, 'EWR');
  assert.equal(r.passengers, 2); // "Passengers: Second Passenger" inside notes is not a count
  assert.match(r.specialInstructions ?? '', /^Customer notes: /);
});

test('unknown driver name is flagged, not treated as unfilled', () => {
  const r = parseReservation(assignedEwrWithNotes, defaultParserConfig([]));
  assert.equal(r.assignment, 'ASSIGNED_UNKNOWN');
  assert.ok(r.reviewFlags.includes('UNKNOWN_DRIVER_NAME'));
});

test('driver matched by invite email when name differs', () => {
  const ev = { ...assignedJfk, description: assignedJfk.description!.replace('Driver: Dana Driver', 'Driver: D. Driver') };
  const r = parseReservation({ ...ev, summary: ev.summary!.replace('Driver: Dana Driver', 'Driver: D. Driver') }, config);
  assert.equal(r.assignedDriverId, 'drv-dana');
  assert.ok(r.reviewFlags.includes('DRIVER_MATCHED_BY_EMAIL'));
});

test('a calendar entry without a name is not an unfilled trip unless it is a reservation', () => {
  const r = parseReservation(internalNote, config);
  assert.equal(r.isReservation, false);
  assert.equal(r.assignment, 'NOT_A_RESERVATION');
});

test('missing information is UNKNOWN and flagged for review', () => {
  const ev = {
    ...unfilledNycCongestion,
    summary: 'HANDY TRANSPORTATION LLC CONFIRMATION: something',
    description: 'Trip: TRP-90009 (confirmed)\nRate: Hourly charter\n',
  };
  const r = parseReservation(ev, config);
  assert.equal(r.isReservation, true);
  assert.equal(r.destinationCode, null);
  assert.equal(r.passengers, null);
  assert.ok(r.reviewFlags.includes('UNRECOGNIZED_RATE'));
  assert.ok(r.reviewFlags.includes('MISSING_DESTINATION'));
  assert.ok(r.reviewFlags.includes('MISSING_PASSENGERS'));
});

test('pickup time text that disagrees with the event start is flagged', () => {
  const ev = { ...unfilledNycCongestion, start: { dateTime: '2026-10-21T16:30:00-04:00' } };
  const r = parseReservation(ev, config);
  assert.ok(r.reviewFlags.includes('PICKUP_TIME_MISMATCH'));
});

test('event end time is NOT used as trip duration', () => {
  const r = parseReservation(unfilledNycCongestion, config);
  assert.ok(r.eventEndAt !== null);
  assert.equal('durationMinutes' in r, false);
});

test('admin-added payout rule extracts a payout', () => {
  const cfg = {
    ...config,
    rules: [...DEFAULT_RULES, { field: 'payout' as const, source: 'DESCRIPTION' as const, pattern: '^\\s*Driver pay:\\s*\\$?([\\d,.]+)', priority: 10, enabled: true }],
  };
  const ev = { ...unfilledNycCongestion, description: unfilledNycCongestion.description + 'Driver pay: $175\n' };
  assert.equal(parseReservation(ev, cfg).payoutCents, 17500);
});

test('invalid admin patterns are rejected and never crash parsing', () => {
  assert.notEqual(validatePattern('(unclosed'), null);
  assert.equal(validatePattern('^Rate:\\s*(.+)$'), null);
  const cfg = { ...config, rules: [{ field: 'passengers' as const, source: 'DESCRIPTION' as const, pattern: '(bad', priority: 1, enabled: true }, ...DEFAULT_RULES] };
  assert.equal(parseReservation(assignedJfk, cfg).passengers, 4);
});
