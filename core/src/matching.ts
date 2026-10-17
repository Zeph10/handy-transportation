import { formatUSD, effectiveMinRate } from './money.ts';
import type { PayoutBreakdown } from './money.ts';
import { formatTime, MS } from './time.ts';
import type { ResolvedSegment, Vehicle } from './types.ts';

/**
 * Eligibility matching for one reservation against every driver.
 *
 * Rules:
 * - The whole required window must be covered, not just the pickup time:
 *   [pickup − travel-to-pickup allowance, pickup + trip duration + post-trip buffer].
 * - Every check runs for every driver so all reasons are reported.
 * - Unknown facts produce REVIEW, never a guess.
 * - Tentative coverage produces TENTATIVE, never ELIGIBLE.
 * - An admin override produces OVERRIDDEN, never ELIGIBLE.
 */

export type MatchStatus = 'ELIGIBLE' | 'TENTATIVE' | 'REVIEW' | 'OVERRIDDEN' | 'INELIGIBLE';
export type ReasonSeverity = 'FAIL' | 'REVIEW' | 'TENTATIVE' | 'INFO';

export type ReasonCode =
  | 'NOT_COVERED'
  | 'TENTATIVE_COVERAGE'
  | 'MIXED_BLOCKS'
  | 'DESTINATION_UNKNOWN'
  | 'DESTINATION_NOT_ACCEPTED'
  | 'PASSENGERS_UNKNOWN'
  | 'NO_VEHICLE'
  | 'INSUFFICIENT_CAPACITY'
  | 'INSUFFICIENT_LUGGAGE'
  | 'LUGGAGE_UNKNOWN'
  | 'PAYOUT_UNKNOWN'
  | 'RATE_TOO_LOW'
  | 'ASSUMED_PRESET_PAYOUT'
  | 'DURATION_UNKNOWN'
  | 'DURATION_ESTIMATED'
  | 'CONFLICT'
  | 'CONGESTION_UNKNOWN';

export interface MatchReason {
  code: ReasonCode;
  severity: ReasonSeverity;
  message: string;
}

export interface MatchReservation {
  id: string;
  pickupAt: number | null;
  destinationId: string | null;
  destinationCode: string | null;
  passengers: number | null;
  checkedBags: number | null;
  /** Effective trip duration in minutes (correction or destination estimate); null = unknown */
  durationMinutes: number | null;
  durationIsEstimate: boolean;
  payout: PayoutBreakdown;
}

export interface AssignedCommitment {
  reservationId: string;
  label: string;
  pickupAt: number;
  durationMinutes: number | null;
}

export interface MatchOverride {
  reason: string;
  createdBy: string;
  createdAt: number;
}

export interface MatchDriver {
  driverId: string;
  name: string;
  /** Resolved timeline covering at least the required window */
  segments: ResolvedSegment[];
  vehicles: Vehicle[];
  /** destinationId → profile default minimum (cents) */
  profileMinimums: Record<string, number | null>;
  /** destinationIds the driver accepts by default (used only for messages) */
  assigned: AssignedCommitment[];
  override?: MatchOverride | null;
}

export interface MatchSettings {
  travelToPickupMinutes: number;
  postTripBufferMinutes: number;
  /** destinationId → company preset (cents) */
  presets: Record<string, number>;
  destinationNames: Record<string, string>;
}

export interface DriverMatch {
  driverId: string;
  name: string;
  status: MatchStatus;
  reasons: MatchReason[];
  window: { start: number; end: number };
  vehicle: Vehicle | null;
  minRateCents: number | null;
  shortfallCents: number | null;
  coveringSegments: ResolvedSegment[];
  override: MatchOverride | null;
}

export interface MatchResult {
  window: { start: number; end: number } | null;
  eligible: DriverMatch[];
  tentative: DriverMatch[];
  review: DriverMatch[];
  overridden: DriverMatch[];
  ineligible: DriverMatch[];
}

export function requiredWindow(
  pickupAt: number,
  durationMinutes: number | null,
  settings: Pick<MatchSettings, 'travelToPickupMinutes' | 'postTripBufferMinutes'>,
): { start: number; end: number } {
  return {
    start: pickupAt - settings.travelToPickupMinutes * MS.MINUTE,
    end: pickupAt + ((durationMinutes ?? 0) + settings.postTripBufferMinutes) * MS.MINUTE,
  };
}

function clip(segments: ResolvedSegment[], start: number, end: number): ResolvedSegment[] {
  return segments
    .filter((s) => s.end > start && s.start < end)
    .map((s) => ({ ...s, start: Math.max(s.start, start), end: Math.min(s.end, end) }));
}

function coverageMessage(clipped: ResolvedSegment[], start: number, end: number): string {
  const ok = (s: ResolvedSegment) => s.status === 'AVAILABLE' || s.status === 'TENTATIVE';
  // Treat any gap in the segment list as UNKNOWN.
  const bad = clipped.filter((s) => !ok(s));
  const firstBad = bad[0];
  const covered = clipped.filter(ok);
  if (covered.length === 0) {
    if (clipped.some((s) => s.source.kind === 'ADMIN_UNAVAILABLE')) return 'Marked unavailable by dispatcher';
    if (clipped.some((s) => s.source.kind === 'TIME_OFF')) return 'On time off during this trip';
    if (clipped.some((s) => s.status === 'UNAVAILABLE')) return 'Marked unavailable during this trip';
    return 'No availability submitted for this time';
  }
  if (firstBad && firstBad.start > start) {
    return `Available only until ${formatTime(firstBad.start)}; trip needs until ${formatTime(end)}`;
  }
  const firstOk = covered[0];
  if (firstOk.start > start) {
    return `Not available until ${formatTime(firstOk.start)}; trip needs from ${formatTime(start)}`;
  }
  return 'Availability has a gap during this trip';
}

function hasGaps(clipped: ResolvedSegment[], start: number, end: number): boolean {
  let cursor = start;
  for (const s of clipped) {
    if (s.start > cursor) return true;
    cursor = Math.max(cursor, s.end);
  }
  return cursor < end;
}

export function matchDriver(r: MatchReservation, d: MatchDriver, settings: MatchSettings): DriverMatch {
  const reasons: MatchReason[] = [];
  const add = (code: ReasonCode, severity: ReasonSeverity, message: string) => reasons.push({ code, severity, message });

  if (r.pickupAt === null) {
    add('NOT_COVERED', 'REVIEW', 'Pickup time unknown');
    return finalize(d, reasons, { start: 0, end: 0 }, null, null, null, []);
  }

  const window = requiredWindow(r.pickupAt, r.durationMinutes, settings);
  if (r.durationMinutes === null) add('DURATION_UNKNOWN', 'REVIEW', 'Trip duration not set; only pickup and buffers checked');
  else if (r.durationIsEstimate) add('DURATION_ESTIMATED', 'INFO', `Trip duration is an estimate (${r.durationMinutes} min)`);

  // 1. Coverage
  const clipped = clip(d.segments, window.start, window.end);
  const fullyCovered = !hasGaps(clipped, window.start, window.end) &&
    clipped.every((s) => s.status === 'AVAILABLE' || s.status === 'TENTATIVE');
  if (!fullyCovered) {
    add('NOT_COVERED', 'FAIL', coverageMessage(clipped, window.start, window.end));
  } else if (clipped.some((s) => s.status === 'TENTATIVE')) {
    add('TENTATIVE_COVERAGE', 'TENTATIVE', 'Tentative availability; confirm with driver');
  }

  const offers = clipped.filter((s) => s.status === 'AVAILABLE' || s.status === 'TENTATIVE');

  // 2. Continuity across blocks
  const vehicleIds = new Set(offers.map((s) => s.vehicleId ?? ''));
  const destSets = new Set(offers.map((s) => s.destinations.map((x) => `${x.destinationId}:${x.minRateCents}`).sort().join(',')));
  if (offers.length > 1 && (vehicleIds.size > 1 || destSets.size > 1)) {
    add('MIXED_BLOCKS', 'REVIEW', 'Trip spans availability blocks with different vehicles or destinations');
  }

  // 3. Destination
  const destName = r.destinationId ? (settings.destinationNames[r.destinationId] ?? r.destinationCode ?? 'this destination') : null;
  if (!r.destinationId) {
    add('DESTINATION_UNKNOWN', 'REVIEW', 'Destination unknown');
  } else if (offers.length > 0 && offers.some((s) => !s.destinations.some((x) => x.destinationId === r.destinationId))) {
    add('DESTINATION_NOT_ACCEPTED', 'FAIL', `Does not accept ${destName}`);
  }

  // 4. Capacity (from the vehicle assigned to the covering block)
  const vehicleId = offers.length > 0 && vehicleIds.size === 1 ? offers[0].vehicleId : null;
  const vehicle = vehicleId ? d.vehicles.find((v) => v.id === vehicleId) ?? null : null;
  if (offers.length > 0) {
    if (!vehicle) {
      add('NO_VEHICLE', 'REVIEW', vehicleIds.size > 1 ? 'Vehicle changes during trip' : 'No vehicle selected for this availability');
    } else {
      if (r.passengers === null) add('PASSENGERS_UNKNOWN', 'REVIEW', 'Passenger count unknown');
      else if (r.passengers > vehicle.maxPassengers) {
        add('INSUFFICIENT_CAPACITY', 'FAIL', `Insufficient passenger capacity: needs ${r.passengers}, ${vehicle.name} seats ${vehicle.maxPassengers}`);
      }
      if (r.checkedBags !== null && vehicle.maxLuggage !== null && r.checkedBags > vehicle.maxLuggage) {
        add('INSUFFICIENT_LUGGAGE', 'FAIL', `Insufficient luggage space: ${r.checkedBags} checked bags, ${vehicle.name} holds ${vehicle.maxLuggage}`);
      } else if (r.checkedBags === null || vehicle.maxLuggage === null) {
        add('LUGGAGE_UNKNOWN', 'INFO', 'Luggage fit not checked (count or capacity unknown)');
      }
    }
  }

  // 5. Rate: compare minimum against the BASE payout; congestion is a separate pass-through line.
  let minRateCents: number | null = null;
  let shortfallCents: number | null = null;
  if (r.destinationId && offers.length > 0) {
    const preset = settings.presets[r.destinationId] ?? 0;
    for (const s of offers) {
      const offer = s.destinations.find((x) => x.destinationId === r.destinationId);
      if (!offer) continue;
      const m = effectiveMinRate({ offer, profileDefaultCents: d.profileMinimums[r.destinationId], presetCents: preset }).cents;
      minRateCents = minRateCents === null ? m : Math.max(minRateCents, m);
    }
    if (r.payout.baseCents === null) {
      add('PAYOUT_UNKNOWN', 'REVIEW', 'Proposed payout unknown');
    } else if (minRateCents !== null && minRateCents > r.payout.baseCents) {
      shortfallCents = minRateCents - r.payout.baseCents;
      add('RATE_TOO_LOW', 'FAIL', `Minimum ${formatUSD(minRateCents)} exceeds proposed ${formatUSD(r.payout.baseCents)} (needs ${formatUSD(shortfallCents)} more)`);
    }
    if (r.payout.baseSource === 'ASSUMED_PRESET') {
      add('ASSUMED_PRESET_PAYOUT', 'INFO', 'Payout assumed from company preset; not stated on the reservation');
    }
  }
  if (r.payout.congestion === 'UNKNOWN' && r.destinationCode === 'NYC') {
    add('CONGESTION_UNKNOWN', 'INFO', 'Congestion surcharge not yet determined');
  }

  // 6. Conflicts with trips already assigned to this driver
  for (const c of d.assigned) {
    if (c.reservationId === r.id) continue;
    const w = requiredWindow(c.pickupAt, c.durationMinutes, settings);
    if (w.start < window.end && w.end > window.start) {
      add('CONFLICT', 'FAIL', `Already assigned ${c.label} at ${formatTime(c.pickupAt)}`);
    }
  }

  return finalize(d, reasons, window, vehicle, minRateCents, shortfallCents, clipped);
}

function finalize(
  d: MatchDriver,
  reasons: MatchReason[],
  window: { start: number; end: number },
  vehicle: Vehicle | null,
  minRateCents: number | null,
  shortfallCents: number | null,
  covering: ResolvedSegment[],
): DriverMatch {
  const order: Record<ReasonSeverity, number> = { FAIL: 0, REVIEW: 1, TENTATIVE: 2, INFO: 3 };
  reasons.sort((a, b) => order[a.severity] - order[b.severity]);
  const has = (s: ReasonSeverity) => reasons.some((r) => r.severity === s);
  let status: MatchStatus;
  if (has('FAIL') || has('REVIEW')) {
    status = d.override ? 'OVERRIDDEN' : has('FAIL') ? 'INELIGIBLE' : 'REVIEW';
  } else if (has('TENTATIVE')) {
    status = 'TENTATIVE';
  } else {
    status = 'ELIGIBLE';
  }
  return {
    driverId: d.driverId,
    name: d.name,
    status,
    reasons,
    window,
    vehicle,
    minRateCents,
    shortfallCents,
    coveringSegments: covering,
    override: d.override ?? null,
  };
}

export function matchReservation(r: MatchReservation, drivers: MatchDriver[], settings: MatchSettings): MatchResult {
  const results = drivers.map((d) => matchDriver(r, d, settings));
  const byName = (a: DriverMatch, b: DriverMatch) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
  const pick = (s: MatchStatus) => results.filter((x) => x.status === s).sort(byName);
  return {
    window: r.pickupAt === null ? null : requiredWindow(r.pickupAt, r.durationMinutes, settings),
    eligible: pick('ELIGIBLE'),
    tentative: pick('TENTATIVE'),
    review: pick('REVIEW'),
    overridden: pick('OVERRIDDEN'),
    ineligible: pick('INELIGIBLE'),
  };
}
