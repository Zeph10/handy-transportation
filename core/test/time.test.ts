import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, daysBetween, formatTime, instantToLocalDate, instantToLocalTime, isLocalDate, isLocalTime,
  localToInstant, startOfWeek, weekdayOf, zoneOffsetMinutes,
} from '../src/time.ts';

const iso = (t: number) => new Date(t).toISOString();

test('standard and daylight time convert correctly', () => {
  assert.equal(iso(localToInstant('2026-01-15', '09:00')), '2026-01-15T14:00:00.000Z'); // EST
  assert.equal(iso(localToInstant('2026-07-15', '09:00')), '2026-07-15T13:00:00.000Z'); // EDT
  assert.equal(zoneOffsetMinutes(localToInstant('2026-01-15', '09:00')), -300);
  assert.equal(zoneOffsetMinutes(localToInstant('2026-07-15', '09:00')), -240);
});

test('spring-forward gap moves forward by the gap (02:30 → 03:30 EDT)', () => {
  const t = localToInstant('2026-03-08', '02:30');
  assert.equal(iso(t), '2026-03-08T07:30:00.000Z');
  assert.equal(instantToLocalTime(t), '03:30');
});

test('fall-back ambiguity resolves to the first occurrence (EDT)', () => {
  const t = localToInstant('2026-11-01', '01:30');
  assert.equal(iso(t), '2026-11-01T05:30:00.000Z');
  assert.equal(zoneOffsetMinutes(t), -240);
});

test('times on either side of transitions are exact', () => {
  assert.equal(iso(localToInstant('2026-03-08', '01:59')), '2026-03-08T06:59:00.000Z');
  assert.equal(iso(localToInstant('2026-03-08', '03:00')), '2026-03-08T07:00:00.000Z');
  assert.equal(iso(localToInstant('2026-11-01', '00:59')), '2026-11-01T04:59:00.000Z');
  assert.equal(iso(localToInstant('2026-11-01', '02:00')), '2026-11-01T07:00:00.000Z');
});

test('round trip local → instant → local away from transitions', () => {
  for (const [d, t] of [['2026-10-21', '15:00'], ['2027-02-28', '23:45'], ['2026-12-31', '00:00']]) {
    const i = localToInstant(d, t);
    assert.equal(instantToLocalDate(i), d);
    assert.equal(instantToLocalTime(i), t);
  }
});

test('date helpers', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(weekdayOf('2026-10-21'), 3); // Wednesday
  assert.equal(weekdayOf('2026-10-25'), 7); // Sunday
  assert.equal(startOfWeek('2026-10-21'), '2026-10-19');
  assert.equal(startOfWeek('2026-10-25'), '2026-10-19');
  assert.equal(daysBetween('2026-10-19', '2026-10-26'), 7);
});

test('validators reject malformed input', () => {
  assert.equal(isLocalDate('2026-02-30'), false);
  assert.equal(isLocalDate('2026-2-3'), false);
  assert.equal(isLocalDate('2026-02-28'), true);
  assert.equal(isLocalTime('24:00'), false);
  assert.equal(isLocalTime('7:00'), false);
  assert.equal(isLocalTime('07:15'), true);
  assert.throws(() => localToInstant('2026-13-01', '00:00'));
});

test('formatTime shows local wall-clock time', () => {
  assert.equal(formatTime(Date.parse('2026-10-21T19:00:00Z')), '3:00 PM');
});
