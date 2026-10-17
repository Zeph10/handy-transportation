import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventToRow, parserConfigFromJson } from '../src/sync.ts';
import { defaultParserConfig, DEFAULT_MARKERS, DEFAULT_RATES, DEFAULT_RULES } from '../src/parser.ts';
import { assignedJfk, internalNote, unfilledNycCongestion } from './fixtures/events.ts';

const config = defaultParserConfig([{ driverId: 'drv-dana', fullName: 'Dana Driver', email: 'dana.driver@example.com', aliases: [] }]);

test('unfilled reservation becomes an UNFILLED row with parsed fields', () => {
  const row = eventToRow({ ...unfilledNycCongestion, etag: '"1"', updated: '2026-10-17T02:07:40Z', iCalUID: 'x@google.com' }, config);
  assert.equal(row.google_event_id, 'evt_unfilled_nyc');
  assert.equal(row.is_reservation, true);
  assert.equal(row.assignment, 'UNFILLED');
  assert.equal(row.destination_code, 'NYC');
  assert.equal(row.congestion, 'YES');
  assert.equal(row.start_at, '2026-10-21T19:00:00.000Z');
  assert.equal(row.etag, '"1"');
  assert.deepEqual(row.attendee_emails, ['support@example-company.test', 'assistant@example.com', 'pat@example.com']);
});

test('assigned reservation carries the matched driver id', () => {
  const row = eventToRow(assignedJfk, config);
  assert.equal(row.assignment, 'ASSIGNED');
  assert.equal(row.assigned_driver_id, 'drv-dana');
});

test('non-reservation events are kept but never treated as trips', () => {
  const row = eventToRow(internalNote, config);
  assert.equal(row.is_reservation, false);
  assert.equal(row.assignment, 'NOT_A_RESERVATION');
});

test('cancelled events are not parsed', () => {
  const row = eventToRow({ id: 'gone', status: 'cancelled' }, config);
  assert.equal(row.source_status, 'cancelled');
  assert.equal(row.is_reservation, false);
  assert.deepEqual(row.parsed, {});
});

test('recurring instance identifiers are preserved', () => {
  const row = eventToRow({ ...internalNote, id: 'base_20261021T140000Z', recurringEventId: 'base', originalStartTime: { dateTime: '2026-10-21T10:00:00-04:00' } }, config);
  assert.equal(row.recurring_event_id, 'base');
  assert.equal(row.original_start, '2026-10-21T14:00:00.000Z');
});

test('parser config JSON from the database maps 1:1', () => {
  const cfg = parserConfigFromJson({ markers: DEFAULT_MARKERS, rules: DEFAULT_RULES, rates: DEFAULT_RATES, drivers: [] });
  assert.equal(eventToRow(unfilledNycCongestion, cfg).destination_code, 'NYC');
});
