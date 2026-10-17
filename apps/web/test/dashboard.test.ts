import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weeklyHeatmap, hasAnyAvailability } from '../src/lib/dashboard.ts';
import { resolveAvailability, localToInstant } from '../../../core/src/index.ts';

const L = localToInstant;
const tl = (blocks: { s: string; e: string; status: 'AVAILABLE' | 'TENTATIVE' | 'UNAVAILABLE' }[]) => resolveAvailability({
  windowStart: L('2026-10-19', '00:00'), windowEnd: L('2026-10-26', '00:00'), timeOff: [], occurrences: [],
  blocks: blocks.map((b, i) => ({ id: String(i), driverId: 'd', start: Date.parse(b.s), end: Date.parse(b.e), status: b.status, vehicleId: 'v', destinations: [] })),
});

test('heatmap counts whole hours; tentative separate; unknown never counted', () => {
  const a = tl([{ s: '2026-10-21T12:00:00Z', e: '2026-10-21T15:30:00Z', status: 'AVAILABLE' }]); // Wed 8:00–11:30
  const b = tl([{ s: '2026-10-21T13:00:00Z', e: '2026-10-21T14:00:00Z', status: 'TENTATIVE' }]); // Wed 9–10
  const c = tl([]); // nothing submitted
  const g = weeklyHeatmap('2026-10-19', [a, b, c]);
  assert.deepEqual(g[2][8], { confirmed: 1, tentative: 0 });
  assert.deepEqual(g[2][9], { confirmed: 1, tentative: 1 });
  assert.deepEqual(g[2][11], { confirmed: 0, tentative: 0 }); // 11:00–11:30 only partly covered
  assert.deepEqual(g[2][7], { confirmed: 0, tentative: 0 });
  assert.equal(hasAnyAvailability(c), false);
  assert.equal(hasAnyAvailability(a), true);
});
