import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyToDates, blocksToTemplate, copyDay, copyWeek, datesForWeekdays, duplicateAfter, templateToBlocks } from '../src/shortcuts.ts';
import { instantToLocalTime, localToInstant } from '../src/time.ts';
import { validateBlock, validateTemplateBlocks, validateVehicle } from '../src/validation.ts';
import type { AvailabilityBlock } from '../src/types.ts';

const L = localToInstant;
const b = (id: string, d: string, s: string, e: string, ed = d): AvailabilityBlock => ({
  id, driverId: 'd', start: L(d, s), end: L(ed, e), status: 'AVAILABLE', vehicleId: 'v',
  destinations: [{ destinationId: 'EWR', minRateCents: 12000 }],
});

test('copy yesterday keeps wall-clock times, including across the DST change', () => {
  // Sat 31 Oct (EDT) → Sun 1 Nov (EST)
  const out = copyDay([b('a', '2026-10-31', '06:00', '14:00')], '2026-10-31', '2026-11-01');
  assert.equal(out.length, 1);
  assert.equal(out[0].start, L('2026-11-01', '06:00'));
  assert.equal(instantToLocalTime(out[0].end), '14:00');
  assert.deepEqual(out[0].destinations, [{ destinationId: 'EWR', minRateCents: 12000 }]);
});

test('copy previous week copies every day and overnight blocks', () => {
  const src = [b('a', '2026-10-19', '06:00', '11:00'), b('n', '2026-10-23', '20:00', '04:00', '2026-10-24'), b('x', '2026-10-26', '06:00', '07:00')];
  const out = copyWeek(src, '2026-10-19', '2026-10-26');
  assert.equal(out.length, 2); // the 26th is not in the source week
  assert.equal(out[1].start, L('2026-10-30', '20:00'));
  assert.equal(out[1].end, L('2026-10-31', '04:00'));
});

test('apply one block to several weekdays', () => {
  const dates = datesForWeekdays('2026-10-19', [1, 3, 5]);
  assert.deepEqual(dates, ['2026-10-19', '2026-10-21', '2026-10-23']);
  const out = applyToDates(b('a', '2026-10-19', '06:00', '11:00'), dates);
  assert.equal(out.length, 2);
  assert.equal(out[0].start, L('2026-10-21', '06:00'));
});

test('duplicate places the copy right after the original', () => {
  const d = duplicateAfter(b('a', '2026-10-19', '06:00', '09:00'));
  assert.equal(d.start, L('2026-10-19', '09:00'));
  assert.equal(d.end, L('2026-10-19', '12:00'));
});

test('templates round-trip to any week', () => {
  const t = blocksToTemplate([b('a', '2026-10-19', '06:00', '11:00'), b('n', '2026-10-23', '20:00', '04:00', '2026-10-24')], '2026-10-19');
  assert.equal(validateTemplateBlocks(t).length, 0);
  assert.deepEqual(t.map((x) => [x.dayOffset, x.localStart, x.localEnd, x.endDayOffset]), [[0, '06:00', '11:00', 0], [4, '20:00', '04:00', 1]]);
  const out = templateToBlocks(t, '2026-11-02');
  assert.equal(out[1].start, L('2026-11-06', '20:00'));
  assert.equal(out[1].end, L('2026-11-07', '04:00'));
});

test('block validation', () => {
  const ok = { start: L('2026-10-19', '06:00'), end: L('2026-10-19', '11:00'), status: 'AVAILABLE' as const, vehicleId: 'v', destinations: [{ destinationId: 'EWR', minRateCents: null }] };
  assert.equal(validateBlock(ok).length, 0);
  assert.ok(validateBlock({ ...ok, end: ok.start }).some((e) => e.field === 'end'));
  assert.ok(validateBlock({ ...ok, destinations: [] }).some((e) => e.field === 'destinations'));
  assert.ok(validateBlock({ ...ok, vehicleId: null }).some((e) => e.field === 'vehicleId'));
  assert.equal(validateBlock({ ...ok, status: 'UNAVAILABLE', vehicleId: null, destinations: [] }).length, 0);
  assert.ok(validateBlock({ ...ok, destinations: [{ destinationId: 'EWR', minRateCents: -1 }] }).length > 0);
});

test('vehicle validation prevents invalid capacity', () => {
  const ok = { name: 'Suburban', vehicleType: 'SUV', maxPassengers: 6, maxLuggage: 6 };
  assert.equal(validateVehicle(ok).length, 0);
  assert.ok(validateVehicle({ ...ok, maxPassengers: 0 }).length > 0);
  assert.ok(validateVehicle({ ...ok, maxPassengers: 2.5 }).length > 0);
  assert.ok(validateVehicle({ ...ok, maxLuggage: -1 }).length > 0);
  assert.ok(validateVehicle({ ...ok, vehicleType: 'BOAT' }).length > 0);
});
