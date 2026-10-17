import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandRules, validateRule } from '../src/recurrence.ts';
import { resolveAvailability, splitAtMidnight } from '../src/resolver.ts';
import { localToInstant, MS } from '../src/time.ts';
import type { AvailabilityBlock, RecurringRule, TimeOff } from '../src/types.ts';

const L = localToInstant;

function rule(over: Partial<RecurringRule> = {}): RecurringRule {
  return {
    id: 'r1', driverId: 'd1', weekdays: [1, 2, 3, 4, 5], localStart: '06:00', localEnd: '11:00',
    endDayOffset: 0, effectiveFrom: '2026-01-01', effectiveUntil: null, status: 'AVAILABLE',
    vehicleId: 'v1', destinations: [{ destinationId: 'EWR', minRateCents: null }], ...over,
  };
}

function block(over: Partial<AvailabilityBlock>): AvailabilityBlock {
  return {
    id: 'b1', driverId: 'd1', start: 0, end: 0, status: 'AVAILABLE', vehicleId: 'v1',
    destinations: [{ destinationId: 'JFK', minRateCents: 25000 }], ...over,
  };
}

test('weekly rule expands only on chosen weekdays within the range', () => {
  const occ = expandRules([rule()], '2026-10-19', '2026-10-25');
  assert.equal(occ.length, 5);
  assert.deepEqual(occ.map((o) => o.occurrenceDate), ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']);
  assert.equal(occ[0].start, L('2026-10-19', '06:00'));
  assert.equal(occ[0].end, L('2026-10-19', '11:00'));
});

test('effective dates bound expansion; no rows are generated beyond the query range', () => {
  const occ = expandRules([rule({ effectiveFrom: '2026-10-21', effectiveUntil: '2026-10-22' })], '2026-10-19', '2026-10-25');
  assert.deepEqual(occ.map((o) => o.occurrenceDate), ['2026-10-21', '2026-10-22']);
  const far = expandRules([rule()], '2030-01-07', '2030-01-07');
  assert.equal(far.length, 1);
});

test('overnight rule starting the day before the range is included', () => {
  const r = rule({ weekdays: [5], localStart: '20:00', localEnd: '04:00', endDayOffset: 1 });
  const occ = expandRules([r], '2026-10-24', '2026-10-24'); // Saturday only
  assert.equal(occ.length, 1);
  assert.equal(occ[0].occurrenceDate, '2026-10-23');
  assert.equal(occ[0].end, L('2026-10-24', '04:00'));
});

test('wall-clock recurrence across DST: Saturday 6 PM–4 AM is 11 real hours on fall-back night, 9 on spring-forward', () => {
  const r = rule({ weekdays: [6], localStart: '18:00', localEnd: '04:00', endDayOffset: 1 });
  const fall = expandRules([r], '2026-10-31', '2026-10-31')[0];
  assert.equal((fall.end - fall.start) / MS.HOUR, 11);
  const spring = expandRules([r], '2026-03-07', '2026-03-07')[0];
  assert.equal((spring.end - spring.start) / MS.HOUR, 9);
  const normal = expandRules([r], '2026-10-24', '2026-10-24')[0];
  assert.equal((normal.end - normal.start) / MS.HOUR, 10);
});

test('a shift ending at a nonexistent 2:00 AM ends at 3:00 AM EDT', () => {
  const r = rule({ weekdays: [6], localStart: '18:00', localEnd: '02:00', endDayOffset: 1 });
  const spring = expandRules([r], '2026-03-07', '2026-03-07')[0];
  assert.equal(new Date(spring.end).toISOString(), '2026-03-08T07:00:00.000Z');
});

test('skip exceptions and modified occurrences suppress the whole occurrence', () => {
  const occ = expandRules([rule()], '2026-10-19', '2026-10-23',
    [{ ruleId: 'r1', occurrenceDate: '2026-10-20' }],
    [{ ruleId: 'r1', occurrenceDate: '2026-10-22' }]);
  assert.deepEqual(occ.map((o) => o.occurrenceDate), ['2026-10-19', '2026-10-21', '2026-10-23']);
});

test('rule validation catches contradictions', () => {
  assert.equal(validateRule(rule()).length, 0);
  assert.ok(validateRule(rule({ weekdays: [] })).length > 0);
  assert.ok(validateRule(rule({ weekdays: [8] })).length > 0);
  assert.ok(validateRule(rule({ localEnd: '05:00' })).length > 0); // end before start, same day
  assert.ok(validateRule(rule({ endDayOffset: 1, localStart: '20:00', localEnd: '21:00' })).length > 0); // >24h
  assert.ok(validateRule(rule({ effectiveUntil: '2025-01-01' })).length > 0);
  assert.equal(validateRule(rule({ endDayOffset: 1, localStart: '20:00', localEnd: '04:00' })).length, 0);
});

test('resolver: unsubmitted time is UNKNOWN, never AVAILABLE', () => {
  const segs = resolveAvailability({
    windowStart: L('2026-10-21', '00:00'), windowEnd: L('2026-10-22', '00:00'),
    timeOff: [], blocks: [], occurrences: [],
  });
  assert.equal(segs.length, 1);
  assert.equal(segs[0].status, 'UNKNOWN');
});

test('resolver: multiple blocks on one day with different statuses (brief example)', () => {
  const blocks = [
    block({ id: 'a', start: L('2026-10-19', '06:00'), end: L('2026-10-19', '11:00'), status: 'AVAILABLE' }),
    block({ id: 'b', start: L('2026-10-19', '11:00'), end: L('2026-10-19', '15:00'), status: 'UNAVAILABLE', destinations: [] }),
    block({ id: 'c', start: L('2026-10-19', '15:00'), end: L('2026-10-19', '22:00'), status: 'AVAILABLE', vehicleId: 'v2' }),
  ];
  const segs = resolveAvailability({ windowStart: L('2026-10-19', '00:00'), windowEnd: L('2026-10-20', '00:00'), timeOff: [], blocks, occurrences: [] });
  assert.deepEqual(segs.map((s) => s.status), ['UNKNOWN', 'AVAILABLE', 'UNAVAILABLE', 'AVAILABLE', 'UNKNOWN']);
  assert.equal(segs[3].vehicleId, 'v2');
});

test('resolver precedence: time off > date-specific block > recurring rule', () => {
  const occurrences = expandRules([rule({ localStart: '06:00', localEnd: '18:00' })], '2026-10-19', '2026-10-23');
  const blocks = [block({ id: 'x', start: L('2026-10-20', '09:00'), end: L('2026-10-20', '12:00'), status: 'UNAVAILABLE', destinations: [] })];
  const timeOff: TimeOff[] = [{ id: 't', driverId: 'd1', startDate: '2026-10-22', endDate: '2026-10-23' }];
  const segs = resolveAvailability({ windowStart: L('2026-10-20', '00:00'), windowEnd: L('2026-10-24', '00:00'), timeOff, blocks, occurrences });

  const at = (d: string, t: string) => segs.find((s) => s.start <= L(d, t) && s.end > L(d, t))!;
  assert.equal(at('2026-10-20', '07:00').status, 'AVAILABLE');
  assert.equal(at('2026-10-20', '07:00').source.kind, 'RULE');
  assert.equal(at('2026-10-20', '10:00').status, 'UNAVAILABLE');
  assert.equal(at('2026-10-20', '10:00').source.kind, 'BLOCK');
  assert.equal(at('2026-10-20', '13:00').source.kind, 'RULE'); // block overrides only where it overlaps
  assert.equal(at('2026-10-22', '10:00').source.kind, 'TIME_OFF');
  assert.equal(at('2026-10-23', '10:00').status, 'UNAVAILABLE');
  assert.equal(at('2026-10-21', '20:00').status, 'UNKNOWN');
});

test('admin "mark unavailable" overrides everything and leaves driver entries intact', () => {
  const blocks = [block({ id: 'k', start: L('2026-10-21', '08:00'), end: L('2026-10-21', '18:00') })];
  const segs = resolveAvailability({
    windowStart: L('2026-10-21', '00:00'), windowEnd: L('2026-10-22', '00:00'), timeOff: [], blocks, occurrences: [],
    adminUnavailable: [{ id: 'au', driverId: 'd1', start: L('2026-10-21', '12:00'), end: L('2026-10-21', '14:00') }],
  });
  assert.deepEqual(segs.map((s) => [s.status, s.source.kind]), [
    ['UNKNOWN', 'NONE'], ['AVAILABLE', 'BLOCK'], ['UNAVAILABLE', 'ADMIN_UNAVAILABLE'], ['AVAILABLE', 'BLOCK'], ['UNKNOWN', 'NONE'],
  ]);
  assert.equal(blocks[0].end, L('2026-10-21', '18:00'));
});

test('resolver segments are contiguous and cover the window exactly', () => {
  const occurrences = expandRules([rule()], '2026-10-19', '2026-10-25');
  const ws = L('2026-10-19', '00:00');
  const we = L('2026-10-26', '00:00');
  const segs = resolveAvailability({ windowStart: ws, windowEnd: we, timeOff: [], blocks: [], occurrences });
  assert.equal(segs[0].start, ws);
  assert.equal(segs[segs.length - 1].end, we);
  for (let i = 1; i < segs.length; i++) assert.equal(segs[i].start, segs[i - 1].end);
});

test('overnight block is one record displayed as two segments split at midnight', () => {
  const parts = splitAtMidnight(L('2026-10-23', '20:00'), L('2026-10-24', '04:00'));
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map((p) => p.localDate), ['2026-10-23', '2026-10-24']);
  assert.equal(parts[0].end, L('2026-10-24', '00:00'));
  assert.equal(parts[1].start, L('2026-10-24', '00:00'));
  assert.equal(splitAtMidnight(L('2026-10-23', '08:00'), L('2026-10-23', '12:00')).length, 1);
});
