import type { LocalDate, LocalTime } from './time.ts';

export type AvailabilityStatus = 'AVAILABLE' | 'TENTATIVE' | 'UNAVAILABLE';
export type ResolvedStatus = AvailabilityStatus | 'UNKNOWN';
export type CongestionState = 'YES' | 'NO' | 'UNKNOWN';

/** Destination accepted in a block or rule, with an optional per-block minimum override. */
export interface DestinationOffer {
  destinationId: string;
  /** null = inherit the driver's profile default */
  minRateCents: number | null;
}

export interface RecurringRule {
  id: string;
  driverId: string;
  /** ISO weekdays, 1 = Monday ... 7 = Sunday */
  weekdays: number[];
  localStart: LocalTime;
  localEnd: LocalTime;
  /** 1 when the shift ends on the following day (overnight) */
  endDayOffset: 0 | 1;
  effectiveFrom: LocalDate;
  effectiveUntil: LocalDate | null;
  status: AvailabilityStatus;
  vehicleId: string | null;
  destinations: DestinationOffer[];
  notes?: string | null;
}

export interface RuleException {
  ruleId: string;
  occurrenceDate: LocalDate;
}

export interface AvailabilityBlock {
  id: string;
  driverId: string;
  start: number;
  end: number;
  status: AvailabilityStatus;
  vehicleId: string | null;
  destinations: DestinationOffer[];
  /** Set when this block replaces one occurrence of a recurring rule */
  ruleId?: string | null;
  occurrenceDate?: LocalDate | null;
  notes?: string | null;
}

export interface TimeOff {
  id: string;
  driverId: string;
  startDate: LocalDate;
  endDate: LocalDate;
  note?: string | null;
}

export interface RuleOccurrence {
  ruleId: string;
  occurrenceDate: LocalDate;
  start: number;
  end: number;
  status: AvailabilityStatus;
  vehicleId: string | null;
  destinations: DestinationOffer[];
}

/** A period an administrator marked a driver unavailable (does not edit the driver's own entries). */
export interface AdminUnavailability {
  id: string;
  driverId: string;
  start: number;
  end: number;
  reason?: string | null;
}

export type SegmentSource =
  | { kind: 'ADMIN_UNAVAILABLE'; id: string }
  | { kind: 'TIME_OFF'; id: string }
  | { kind: 'BLOCK'; id: string }
  | { kind: 'RULE'; id: string; occurrenceDate: LocalDate }
  | { kind: 'NONE' };

export interface ResolvedSegment {
  start: number;
  end: number;
  status: ResolvedStatus;
  source: SegmentSource;
  vehicleId: string | null;
  destinations: DestinationOffer[];
}

export interface Vehicle {
  id: string;
  name: string;
  maxPassengers: number;
  maxLuggage: number | null;
  isActive: boolean;
}
