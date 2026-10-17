import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeChange, describeRequest } from '../src/lib/describe.ts';

const blk = (s: string, e: string, status = 'AVAILABLE') => ({ start_at: s, end_at: e, status });

test('requests read as plain English', () => {
  assert.equal(describeRequest({ action: 'DELETE_BLOCK', prior: blk('2026-10-21T12:00:00Z', '2026-10-21T20:00:00Z'), proposed: null }),
    'Remove Available Wed, Oct 21, 8:00 AM–4:00 PM');
  assert.match(describeRequest({ action: 'UPDATE_BLOCK', prior: blk('2026-10-21T12:00:00Z', '2026-10-21T20:00:00Z'), proposed: blk('2026-10-21T12:00:00Z', '2026-10-21T16:00:00Z') }),
    /→ Wed, Oct 21, 8:00 AM–12:00 PM$/);
  assert.equal(describeRequest({ action: 'ADD_TIME_OFF', prior: null, proposed: { start_date: '2026-10-21', end_date: '2026-10-23' } }), 'Time off Wed, Oct 21 – Fri, Oct 23');
});

test('admin changes read as plain English', () => {
  assert.equal(describeChange({ action: 'BLOCK_UPDATED', entity_table: 'availability_blocks', before: blk('2026-10-21T12:00:00Z', '2026-10-21T20:00:00Z'), after: blk('2026-10-21T12:00:00Z', '2026-10-21T20:00:00Z', 'UNAVAILABLE') }),
    'Changed Wed, Oct 21, 8:00 AM–4:00 PM → Wed, Oct 21, 8:00 AM–4:00 PM (now Unavailable)');
  assert.equal(describeChange({ action: 'insert', entity_table: 'admin_unavailability', before: null, after: blk('2026-10-21T12:00:00Z', '2026-10-21T14:00:00Z') }),
    'Marked you unavailable Wed, Oct 21, 8:00 AM–10:00 AM');
});
