// Pure conversions between database rows and the shared core types.
// Kept free of browser/React imports so it is unit-tested with node:test.
import {
  expandRules,
  resolveAvailability,
  addDays,
  localToInstant,
} from '../../../../core/src/index.ts';
import type {
  AdminUnavailability,
  AvailabilityBlock,
  DestinationOffer,
  RecurringRule,
  ResolvedSegment,
  RuleException,
  RuleOccurrence,
  TimeOff,
  LocalDate,
} from '../../../../core/src/index.ts';
import type { AdminUnavailabilityRow, BlockRow, DestOfferRow, ExceptionRow, RuleRow, TimeOffRow } from './types.ts';

const hhmm = (t: string) => t.slice(0, 5);

export function offersFromRows(rows: DestOfferRow[] | null | undefined): DestinationOffer[] {
  return (rows ?? []).map((d) => ({ destinationId: d.destination_id, minRateCents: d.min_rate_cents }));
}

export function blockFromRow(r: BlockRow): AvailabilityBlock {
  return {
    id: r.id,
    driverId: r.driver_id,
    start: Date.parse(r.start_at),
    end: Date.parse(r.end_at),
    status: r.status,
    vehicleId: r.vehicle_id,
    destinations: offersFromRows(r.availability_block_destinations),
    ruleId: r.rule_id,
    occurrenceDate: r.occurrence_date,
    notes: r.notes,
  };
}

export function ruleFromRow(r: RuleRow): RecurringRule {
  return {
    id: r.id,
    driverId: r.driver_id,
    weekdays: r.weekdays,
    localStart: hhmm(r.local_start),
    localEnd: hhmm(r.local_end),
    endDayOffset: r.end_day_offset,
    effectiveFrom: r.effective_from,
    effectiveUntil: r.effective_until,
    status: r.status,
    vehicleId: r.vehicle_id,
    destinations: offersFromRows(r.availability_rule_destinations),
    notes: r.notes,
  };
}

export function timeOffFromRow(r: TimeOffRow): TimeOff {
  return { id: r.id, driverId: r.driver_id, startDate: r.start_date, endDate: r.end_date, note: r.note };
}

export function adminUnavailabilityFromRow(r: AdminUnavailabilityRow): AdminUnavailability {
  return { id: r.id, driverId: r.driver_id, start: Date.parse(r.start_at), end: Date.parse(r.end_at), reason: r.reason };
}

export function exceptionFromRow(r: ExceptionRow): RuleException {
  return { ruleId: r.rule_id, occurrenceDate: r.occurrence_date };
}

export interface DriverSchedule {
  blocks: AvailabilityBlock[];
  rules: RecurringRule[];
  exceptions: RuleException[];
  timeOff: TimeOff[];
  adminUnavailable: AdminUnavailability[];
}

export function scheduleFromRows(rows: {
  blocks: BlockRow[];
  rules: RuleRow[];
  exceptions: ExceptionRow[];
  timeOff: TimeOffRow[];
  adminUnavailable: AdminUnavailabilityRow[];
}): DriverSchedule {
  return {
    blocks: rows.blocks.map(blockFromRow),
    rules: rows.rules.map(ruleFromRow),
    exceptions: rows.exceptions.map(exceptionFromRow),
    timeOff: rows.timeOff.map(timeOffFromRow),
    adminUnavailable: rows.adminUnavailable.map(adminUnavailabilityFromRow),
  };
}

/** Recurring occurrences for a local date range (inclusive), honouring exceptions and modified occurrences. */
export function occurrencesFor(s: DriverSchedule, from: LocalDate, to: LocalDate): RuleOccurrence[] {
  return expandRules(s.rules, from, to, s.exceptions, s.blocks);
}

/** Resolved timeline for a local date range (inclusive). */
export function timelineFor(s: DriverSchedule, from: LocalDate, to: LocalDate): ResolvedSegment[] {
  return resolveAvailability({
    windowStart: localToInstant(from, '00:00'),
    windowEnd: localToInstant(addDays(to, 1), '00:00'),
    timeOff: s.timeOff,
    blocks: s.blocks,
    occurrences: occurrencesFor(s, from, to),
    adminUnavailable: s.adminUnavailable,
  });
}

/** Payload for the save_block / admin_save_block RPCs. */
export function blockPayload(b: {
  start: number;
  end: number;
  status: AvailabilityBlock['status'];
  vehicleId: string | null;
  destinations: DestinationOffer[];
  notes?: string | null;
  ruleId?: string | null;
  occurrenceDate?: string | null;
}): Record<string, unknown> {
  return {
    start_at: new Date(b.start).toISOString(),
    end_at: new Date(b.end).toISOString(),
    status: b.status,
    vehicle_id: b.status === 'UNAVAILABLE' ? null : b.vehicleId,
    notes: b.notes ?? null,
    destinations: b.status === 'UNAVAILABLE' ? [] : b.destinations.map((d) => ({ destination_id: d.destinationId, min_rate_cents: d.minRateCents })),
    ...(b.ruleId ? { rule_id: b.ruleId, occurrence_date: b.occurrenceDate } : {}),
  };
}

/** Payload for the save_rule RPC. */
export function rulePayload(r: Omit<RecurringRule, 'id' | 'driverId'>): Record<string, unknown> {
  return {
    weekdays: r.weekdays,
    local_start: r.localStart,
    local_end: r.localEnd,
    end_day_offset: r.endDayOffset,
    effective_from: r.effectiveFrom,
    effective_until: r.effectiveUntil,
    status: r.status,
    vehicle_id: r.status === 'UNAVAILABLE' ? null : r.vehicleId,
    notes: r.notes ?? null,
    destinations: r.status === 'UNAVAILABLE' ? [] : r.destinations.map((d) => ({ destination_id: d.destinationId, min_rate_cents: d.minRateCents })),
  };
}
