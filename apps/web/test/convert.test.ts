import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockFromRow, blockPayload, ruleFromRow, rulePayload, scheduleFromRows, timelineFor } from '../src/lib/convert.ts';

const blockRow = {
  id: 'b1', driver_id: 'd', start_at: '2026-10-21T10:00:00+00:00', end_at: '2026-10-21T15:00:00+00:00', status: 'AVAILABLE' as const,
  vehicle_id: 'v', notes: null, rule_id: null, occurrence_date: null, origin: 'DRIVER' as const, version: 3,
  availability_block_destinations: [{ destination_id: 'nyc', min_rate_cents: 17000 }],
};
const ruleRow = {
  id: 'r1', driver_id: 'd', weekdays: [3], local_start: '18:00:00', local_end: '22:00:00', end_day_offset: 0 as const,
  effective_from: '2026-01-01', effective_until: null, status: 'TENTATIVE' as const, vehicle_id: 'v', notes: null, version: 1,
  availability_rule_destinations: [{ destination_id: 'jfk', min_rate_cents: null }],
};

test('rows convert to core types', () => {
  const b = blockFromRow(blockRow);
  assert.equal(b.start, Date.parse('2026-10-21T10:00:00Z'));
  assert.deepEqual(b.destinations, [{ destinationId: 'nyc', minRateCents: 17000 }]);
  const r = ruleFromRow(ruleRow);
  assert.equal(r.localStart, '18:00');
  assert.equal(r.localEnd, '22:00');
});

test('timeline combines blocks and recurring rules for a day', () => {
  const s = scheduleFromRows({ blocks: [blockRow], rules: [ruleRow], exceptions: [], timeOff: [], adminUnavailable: [] });
  const segs = timelineFor(s, '2026-10-21', '2026-10-21');
  assert.deepEqual(segs.map((x) => x.status), ['UNKNOWN', 'AVAILABLE', 'UNKNOWN', 'TENTATIVE', 'UNKNOWN']);
});

test('payloads match the RPC contract', () => {
  const p = blockPayload({ start: Date.parse('2026-10-21T10:00:00Z'), end: Date.parse('2026-10-21T15:00:00Z'), status: 'UNAVAILABLE', vehicleId: 'v', destinations: [{ destinationId: 'x', minRateCents: 1 }] });
  assert.equal(p.vehicle_id, null);
  assert.deepEqual(p.destinations, []);
  const rp = rulePayload({ ...ruleFromRow(ruleRow) });
  assert.deepEqual(rp.destinations, [{ destination_id: 'jfk', min_rate_cents: null }]);
  assert.equal(rp.local_start, '18:00');
});
