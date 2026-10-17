import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchReservation, requiredWindow } from '../src/matching.ts';
import type { MatchDriver, MatchReservation, MatchSettings } from '../src/matching.ts';
import { payoutBreakdown, effectiveMinRate, formatUSD, parseDollars } from '../src/money.ts';
import { resolveAvailability } from '../src/resolver.ts';
import { expandRules } from '../src/recurrence.ts';
import { localToInstant, MS } from '../src/time.ts';
import type { AvailabilityBlock, Vehicle } from '../src/types.ts';

const L = localToInstant;
const DAY_START = L('2026-10-21', '00:00');
const DAY_END = L('2026-10-22', '00:00');

const settings: MatchSettings = {
  travelToPickupMinutes: 60,
  postTripBufferMinutes: 30,
  presets: { EWR: 11000, LGA: 16500, JFK: 21000, NYC: 16000 },
  destinationNames: { EWR: 'EWR', LGA: 'LGA', JFK: 'JFK', NYC: 'NYC' },
};

const sedan: Vehicle = { id: 'sedan', name: 'Sedan', maxPassengers: 3, maxLuggage: 3, isActive: true };
const suv: Vehicle = { id: 'suv', name: 'Suburban', maxPassengers: 6, maxLuggage: 6, isActive: true };

function blk(id: string, from: string, to: string, over: Partial<AvailabilityBlock> = {}): AvailabilityBlock {
  return {
    id, driverId: 'x', start: L('2026-10-21', from), end: L('2026-10-21', to), status: 'AVAILABLE', vehicleId: 'suv',
    destinations: [{ destinationId: 'NYC', minRateCents: null }, { destinationId: 'JFK', minRateCents: null }], ...over,
  };
}

function driver(name: string, blocks: AvailabilityBlock[], over: Partial<MatchDriver> = {}): MatchDriver {
  return {
    driverId: name.toLowerCase(), name,
    segments: resolveAvailability({ windowStart: DAY_START, windowEnd: DAY_END, timeOff: [], blocks, occurrences: [] }),
    vehicles: [sedan, suv],
    profileMinimums: { NYC: 16000, JFK: 21000 },
    assigned: [],
    ...over,
  };
}

// Modelled on TRP-04327: unfilled NYC trip, 3:00 PM, 1 passenger, congestion applies, no payout stated.
function nycTrip(over: Partial<MatchReservation> = {}): MatchReservation {
  return {
    id: 'res-nyc', pickupAt: L('2026-10-21', '15:00'), destinationId: 'NYC', destinationCode: 'NYC',
    passengers: 1, checkedBags: 0, durationMinutes: 75, durationIsEstimate: true,
    payout: payoutBreakdown({ presetCents: 16000, assumePresetWhenMissing: true, congestion: 'YES', congestionEligible: true, surchargeCents: 900 }),
    ...over,
  };
}

test('required window = pickup − travel allowance … pickup + duration + buffer', () => {
  const w = requiredWindow(L('2026-10-21', '15:00'), 75, settings);
  assert.equal(w.start, L('2026-10-21', '14:00'));
  assert.equal(w.end, L('2026-10-21', '16:45'));
});

test('NYC congestion payout: base and surcharge stay separate; minimum compared to base', () => {
  const r = nycTrip();
  assert.equal(r.payout.baseCents, 16000);
  assert.equal(r.payout.baseSource, 'ASSUMED_PRESET');
  assert.equal(r.payout.congestionCents, 900);
  assert.equal(r.payout.totalCents, 16900);
  // A $165 minimum is NOT met by $160 base even though the total is $169.
  const res = matchReservation(r, [driver('Ava', [blk('a', '13:00', '18:00')], { profileMinimums: { NYC: 16500 } })], settings);
  assert.equal(res.ineligible.length, 1);
  assert.match(res.ineligible[0].reasons.find((x) => x.code === 'RATE_TOO_LOW')!.message, /needs \$5 more/);
});

test('fully covered, accepting, big enough, rate met → ELIGIBLE (with assumed-preset note)', () => {
  const res = matchReservation(nycTrip(), [driver('Ava', [blk('a', '13:00', '18:00')])], settings);
  assert.equal(res.eligible.length, 1);
  const m = res.eligible[0];
  assert.equal(m.vehicle?.id, 'suv');
  assert.equal(m.minRateCents, 16000);
  assert.ok(m.reasons.some((x) => x.code === 'ASSUMED_PRESET_PAYOUT' && x.severity === 'INFO'));
});

test('criterion 19: covering only part of the window is NOT eligible', () => {
  // Pickup 3:00 PM is inside 1–4 PM, but the trip needs until 4:45 PM.
  const res = matchReservation(nycTrip(), [driver('Ben', [blk('b', '13:00', '16:00')])], settings);
  assert.equal(res.eligible.length, 0);
  assert.equal(res.ineligible.length, 1);
  assert.match(res.ineligible[0].reasons[0].message ?? '', /Available only until 4:00 PM/);
  // Starting too late (needs from 2:00 PM for travel to pickup)
  const late = matchReservation(nycTrip(), [driver('Cy', [blk('c', '14:30', '20:00')])], settings);
  assert.match(late.ineligible[0].reasons.find((x) => x.code === 'NOT_COVERED')!.message, /Not available until 2:30 PM/);
});

test('criterion 17: insufficient passenger capacity is rejected', () => {
  const r = nycTrip({ passengers: 4 });
  const res = matchReservation(r, [driver('Dee', [blk('d', '12:00', '20:00', { vehicleId: 'sedan' })])], settings);
  assert.equal(res.ineligible.length, 1);
  assert.match(res.ineligible[0].reasons.find((x) => x.code === 'INSUFFICIENT_CAPACITY')!.message, /needs 4, Sedan seats 3/);
});

test('criterion 18: minimum above payout shows the minimum and the difference', () => {
  const r = nycTrip({ destinationId: 'JFK', destinationCode: 'JFK', payout: payoutBreakdown({ calendarCents: 19000, assumePresetWhenMissing: true, congestion: 'NO', congestionEligible: false, surchargeCents: 900 }) });
  const res = matchReservation(r, [driver('Eve', [blk('e', '12:00', '20:00', { destinations: [{ destinationId: 'JFK', minRateCents: 22500 }] })])], settings);
  const m = res.ineligible[0];
  assert.equal(m.minRateCents, 22500); // per-block override beats profile default (21000)
  assert.equal(m.shortfallCents, 3500);
  assert.match(m.reasons.find((x) => x.code === 'RATE_TOO_LOW')!.message, /Minimum \$225 exceeds proposed \$190 \(needs \$35 more\)/);
});

test('destination not accepted is a named failure', () => {
  const res = matchReservation(nycTrip(), [driver('Fay', [blk('f', '12:00', '20:00', { destinations: [{ destinationId: 'JFK', minRateCents: null }] })])], settings);
  assert.ok(res.ineligible[0].reasons.some((x) => x.message === 'Does not accept NYC'));
});

test('criterion 21: an existing assignment creates a conflict', () => {
  const d = driver('Gus', [blk('g', '08:00', '22:00')], {
    assigned: [{ reservationId: 'res-other', label: 'TRP-90003', pickupAt: L('2026-10-21', '16:00'), durationMinutes: 60 }],
  });
  const res = matchReservation(nycTrip(), [d], settings);
  assert.ok(res.ineligible[0].reasons.some((x) => x.code === 'CONFLICT' && /TRP-90003 at 4:00 PM/.test(x.message)));
});

test('tentative coverage is TENTATIVE, never ELIGIBLE', () => {
  const res = matchReservation(nycTrip(), [driver('Hal', [blk('h', '12:00', '20:00', { status: 'TENTATIVE' })])], settings);
  assert.equal(res.eligible.length, 0);
  assert.equal(res.tentative.length, 1);
});

test('criterion 20: unknown destination / passengers / payout / duration → REVIEW, not a guess', () => {
  const d = [driver('Ivy', [blk('i', '08:00', '22:00')])];
  assert.equal(matchReservation(nycTrip({ destinationId: null, destinationCode: null }), d, settings).review.length, 1);
  assert.equal(matchReservation(nycTrip({ passengers: null }), d, settings).review.length, 1);
  assert.equal(matchReservation(nycTrip({ durationMinutes: null }), d, settings).review.length, 1);
  const unknownPay = payoutBreakdown({ assumePresetWhenMissing: false, presetCents: 16000, congestion: 'YES', congestionEligible: true, surchargeCents: 900 });
  assert.equal(unknownPay.baseCents, null);
  assert.equal(matchReservation(nycTrip({ payout: unknownPay }), d, settings).review.length, 1);
});

test('UNKNOWN availability is never eligible', () => {
  const res = matchReservation(nycTrip(), [driver('Jo', [])], settings);
  assert.equal(res.ineligible[0].reasons[0].message, 'No availability submitted for this time');
});

test('override is visible as OVERRIDDEN and never becomes a normal match', () => {
  const d = driver('Kim', [blk('k', '13:00', '16:00')], { override: { reason: 'Driver confirmed by phone', createdBy: 'admin', createdAt: 0 } });
  const res = matchReservation(nycTrip(), [d], settings);
  assert.equal(res.eligible.length, 0);
  assert.equal(res.overridden.length, 1);
  assert.ok(res.overridden[0].reasons.length > 0); // original reasons kept
});

test('window spanning blocks with different vehicles requires review', () => {
  const res = matchReservation(nycTrip(), [driver('Lu', [blk('l1', '12:00', '15:30', { vehicleId: 'suv' }), blk('l2', '15:30', '20:00', { vehicleId: 'sedan' })])], settings);
  assert.equal(res.review.length, 1);
  assert.ok(res.review[0].reasons.some((x) => x.code === 'MIXED_BLOCKS'));
});

test('recurring availability feeds matching through the resolver', () => {
  const occurrences = expandRules([{
    id: 'r', driverId: 'm', weekdays: [3], localStart: '12:00', localEnd: '20:00', endDayOffset: 0,
    effectiveFrom: '2026-01-01', effectiveUntil: null, status: 'AVAILABLE', vehicleId: 'suv',
    destinations: [{ destinationId: 'NYC', minRateCents: null }],
  }], '2026-10-21', '2026-10-21');
  const d: MatchDriver = {
    driverId: 'm', name: 'Mo', vehicles: [suv], profileMinimums: { NYC: 15000 }, assigned: [],
    segments: resolveAvailability({ windowStart: DAY_START, windowEnd: DAY_END, timeOff: [], blocks: [], occurrences }),
  };
  assert.equal(matchReservation(nycTrip(), [d], settings).eligible.length, 1);
  // Time off overrides the recurring schedule.
  d.segments = resolveAvailability({ windowStart: DAY_START, windowEnd: DAY_END, timeOff: [{ id: 't', driverId: 'm', startDate: '2026-10-21', endDate: '2026-10-21' }], blocks: [], occurrences });
  assert.equal(matchReservation(nycTrip(), [d], settings).ineligible[0].reasons[0].message, 'On time off during this trip');
});

test('results are alphabetical within each group', () => {
  const res = matchReservation(nycTrip(), ['zed', 'Amy', 'bob'].map((n) => driver(n, [blk(n, '08:00', '22:00')])), settings);
  assert.deepEqual(res.eligible.map((x) => x.name), ['Amy', 'bob', 'zed']);
});

test('money helpers', () => {
  assert.equal(parseDollars('$160'), 16000);
  assert.equal(parseDollars('165.5'), 16550);
  assert.equal(parseDollars('1,200.05'), 120005);
  assert.equal(parseDollars('abc'), null);
  assert.equal(formatUSD(16900), '$169');
  assert.equal(formatUSD(900), '$9');
  assert.equal(formatUSD(16550), '$165.50');
  assert.deepEqual(effectiveMinRate({ offer: { destinationId: 'NYC', minRateCents: null }, profileDefaultCents: null, presetCents: 16000 }), { cents: 16000, source: 'PRESET' });
  assert.deepEqual(effectiveMinRate({ offer: { destinationId: 'NYC', minRateCents: null }, profileDefaultCents: 15000, presetCents: 16000 }), { cents: 15000, source: 'PROFILE' });
  assert.deepEqual(effectiveMinRate({ offer: { destinationId: 'NYC', minRateCents: 17000 }, profileDefaultCents: 15000, presetCents: 16000 }), { cents: 17000, source: 'BLOCK' });
});

test('congestion surcharge: never applied automatically, never double counted', () => {
  const unknown = payoutBreakdown({ presetCents: 16000, assumePresetWhenMissing: true, congestion: 'UNKNOWN', congestionEligible: true, surchargeCents: 900 });
  assert.equal(unknown.congestionCents, 0);
  assert.equal(unknown.totalCents, 16000);
  const notEligible = payoutBreakdown({ calendarCents: 21000, assumePresetWhenMissing: true, congestion: 'YES', congestionEligible: false, surchargeCents: 900 });
  assert.equal(notEligible.congestionCents, 0);
  const corrected = payoutBreakdown({ correctedCents: 18000, calendarCents: 17000, presetCents: 16000, assumePresetWhenMissing: true, congestion: 'YES', congestionEligible: true, surchargeCents: 900 });
  assert.equal(corrected.baseSource, 'CORRECTED');
  assert.equal(corrected.totalCents, 18900);
});

test('durations are minutes, not hours (guard)', () => {
  assert.equal(MS.MINUTE * 60, MS.HOUR);
});
