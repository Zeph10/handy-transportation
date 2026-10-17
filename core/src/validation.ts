import { isLocalDate, isLocalTime, MS } from './time.ts';
import type { AvailabilityStatus, DestinationOffer } from './types.ts';

/**
 * Dependency-free validators shared by the browser (forms) and Edge
 * Functions. The database repeats every rule in SQL, so a hand-crafted
 * request gets the same answer.
 */

export interface FieldError {
  field: string;
  message: string;
}

const STATUSES: AvailabilityStatus[] = ['AVAILABLE', 'TENTATIVE', 'UNAVAILABLE'];
const MAX_BLOCK_MS = 7 * MS.DAY;

export const LIMITS = {
  maxPassengers: 60,
  maxLuggage: 100,
  maxRateCents: 1_000_000,
  maxNotes: 1000,
  maxName: 120,
} as const;

function validateDestinations(dests: unknown, errors: FieldError[]): void {
  if (!Array.isArray(dests)) {
    errors.push({ field: 'destinations', message: 'Destinations are missing.' });
    return;
  }
  const seen = new Set<string>();
  for (const d of dests as DestinationOffer[]) {
    if (!d || typeof d.destinationId !== 'string' || !d.destinationId) {
      errors.push({ field: 'destinations', message: 'A destination is invalid.' });
      continue;
    }
    if (seen.has(d.destinationId)) errors.push({ field: 'destinations', message: 'A destination is listed twice.' });
    seen.add(d.destinationId);
    if (d.minRateCents !== null && (!Number.isInteger(d.minRateCents) || d.minRateCents < 0 || d.minRateCents > LIMITS.maxRateCents)) {
      errors.push({ field: `rate.${d.destinationId}`, message: 'Minimum rate must be between $0 and $10,000.' });
    }
  }
}

export interface BlockInput {
  start: number;
  end: number;
  status: AvailabilityStatus;
  vehicleId: string | null;
  destinations: DestinationOffer[];
  notes?: string | null;
}

export function validateBlock(b: BlockInput): FieldError[] {
  const errors: FieldError[] = [];
  if (!Number.isFinite(b.start)) errors.push({ field: 'start', message: 'Start time is required.' });
  if (!Number.isFinite(b.end)) errors.push({ field: 'end', message: 'End time is required.' });
  if (Number.isFinite(b.start) && Number.isFinite(b.end)) {
    if (b.end <= b.start) errors.push({ field: 'end', message: 'End must be after start.' });
    else if (b.end - b.start > MAX_BLOCK_MS) errors.push({ field: 'end', message: 'A single block can be at most 7 days long.' });
  }
  if (!STATUSES.includes(b.status)) errors.push({ field: 'status', message: 'Choose Available, Tentative or Unavailable.' });
  if (b.status !== 'UNAVAILABLE') {
    validateDestinations(b.destinations, errors);
    if (Array.isArray(b.destinations) && b.destinations.length === 0) {
      errors.push({ field: 'destinations', message: 'Pick at least one destination.' });
    }
    if (!b.vehicleId) errors.push({ field: 'vehicleId', message: 'Choose the vehicle you will drive.' });
  }
  if (b.notes && b.notes.length > LIMITS.maxNotes) errors.push({ field: 'notes', message: 'Notes are too long.' });
  return errors;
}

export interface VehicleInput {
  name: string;
  makeModel?: string | null;
  vehicleType: string;
  maxPassengers: number;
  maxLuggage: number | null;
  accessibilityNotes?: string | null;
}

export const VEHICLE_TYPES = ['SEDAN', 'SUV', 'VAN', 'SPRINTER', 'MINIBUS', 'OTHER'] as const;

export function validateVehicle(v: VehicleInput): FieldError[] {
  const errors: FieldError[] = [];
  if (!v.name || !v.name.trim()) errors.push({ field: 'name', message: 'Give the vehicle a name.' });
  else if (v.name.length > LIMITS.maxName) errors.push({ field: 'name', message: 'Name is too long.' });
  if (!(VEHICLE_TYPES as readonly string[]).includes(v.vehicleType)) errors.push({ field: 'vehicleType', message: 'Choose a vehicle type.' });
  if (!Number.isInteger(v.maxPassengers) || v.maxPassengers < 1 || v.maxPassengers > LIMITS.maxPassengers) {
    errors.push({ field: 'maxPassengers', message: `Passenger capacity must be 1 to ${LIMITS.maxPassengers}.` });
  }
  if (v.maxLuggage !== null && (!Number.isInteger(v.maxLuggage) || v.maxLuggage < 0 || v.maxLuggage > LIMITS.maxLuggage)) {
    errors.push({ field: 'maxLuggage', message: `Luggage capacity must be 0 to ${LIMITS.maxLuggage}.` });
  }
  return errors;
}

export function validateProfile(p: { fullName: string; phone?: string | null; driverNotes?: string | null }): FieldError[] {
  const errors: FieldError[] = [];
  if (!p.fullName || !p.fullName.trim()) errors.push({ field: 'fullName', message: 'Enter your full name.' });
  else if (p.fullName.length > LIMITS.maxName) errors.push({ field: 'fullName', message: 'Name is too long.' });
  if (p.phone && !/^[+\d][\d\s().-]{6,24}$/.test(p.phone)) errors.push({ field: 'phone', message: 'Phone number looks invalid.' });
  if (p.driverNotes && p.driverNotes.length > LIMITS.maxNotes) errors.push({ field: 'driverNotes', message: 'Notes are too long.' });
  return errors;
}

export function validateTimeOff(t: { startDate: string; endDate: string }): FieldError[] {
  const errors: FieldError[] = [];
  if (!isLocalDate(t.startDate)) errors.push({ field: 'startDate', message: 'Start date is invalid.' });
  if (!isLocalDate(t.endDate)) errors.push({ field: 'endDate', message: 'End date is invalid.' });
  if (isLocalDate(t.startDate) && isLocalDate(t.endDate) && t.endDate < t.startDate) {
    errors.push({ field: 'endDate', message: 'End date is before start date.' });
  }
  return errors;
}

/** A template stores blocks as day offsets + wall-clock times, so it can be applied to any week. */
export interface TemplateBlock {
  dayOffset: number; // 0 = Monday of the target week (week template) or the target day (day template)
  localStart: string;
  localEnd: string;
  endDayOffset: 0 | 1;
  status: AvailabilityStatus;
  vehicleId: string | null;
  destinations: DestinationOffer[];
  notes?: string | null;
}

export function validateTemplateBlocks(blocks: TemplateBlock[]): FieldError[] {
  const errors: FieldError[] = [];
  if (!Array.isArray(blocks) || blocks.length === 0) return [{ field: 'blocks', message: 'A template needs at least one block.' }];
  if (blocks.length > 100) return [{ field: 'blocks', message: 'A template can hold at most 100 blocks.' }];
  blocks.forEach((b, i) => {
    if (!Number.isInteger(b.dayOffset) || b.dayOffset < 0 || b.dayOffset > 6) errors.push({ field: `blocks.${i}.dayOffset`, message: 'Day is invalid.' });
    if (!isLocalTime(b.localStart) || !isLocalTime(b.localEnd)) errors.push({ field: `blocks.${i}.time`, message: 'Time is invalid.' });
    else if (b.endDayOffset === 0 && b.localEnd <= b.localStart) errors.push({ field: `blocks.${i}.time`, message: 'End must be after start.' });
    if (!STATUSES.includes(b.status)) errors.push({ field: `blocks.${i}.status`, message: 'Status is invalid.' });
  });
  return errors;
}
