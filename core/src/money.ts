import type { CongestionState, DestinationOffer } from './types.ts';

/** All money is integer cents. These helpers never use floating-point math on cents. */

export function assertCents(value: unknown, field = 'amount'): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 10_000_000) {
    throw new RangeError(`${field} must be a whole number of cents between 0 and 10,000,000`);
  }
  return value;
}

/** Parse "$160", "160", "160.50" into cents. Returns null when unparseable. */
export function parseDollars(input: string): number | null {
  const s = input.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}

export function formatUSD(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  const d = dollars.toLocaleString('en-US');
  return rem === 0 ? `${sign}$${d}` : `${sign}$${d}.${String(rem).padStart(2, '0')}`;
}

export type MinRateSource = 'BLOCK' | 'PROFILE' | 'PRESET';

/**
 * A driver's effective minimum for one destination in one availability window:
 * per-block (or per-rule) override → profile default → company preset.
 */
export function effectiveMinRate(args: {
  offer: DestinationOffer | undefined;
  profileDefaultCents: number | null | undefined;
  presetCents: number;
}): { cents: number; source: MinRateSource } {
  if (args.offer && args.offer.minRateCents !== null && args.offer.minRateCents !== undefined) {
    return { cents: args.offer.minRateCents, source: 'BLOCK' };
  }
  if (args.profileDefaultCents !== null && args.profileDefaultCents !== undefined) {
    return { cents: args.profileDefaultCents, source: 'PROFILE' };
  }
  return { cents: args.presetCents, source: 'PRESET' };
}

export type PayoutSource = 'CORRECTED' | 'CALENDAR' | 'ASSUMED_PRESET' | 'UNKNOWN';

export interface PayoutBreakdown {
  /** Base driver payout, excluding the congestion surcharge. null = unknown */
  baseCents: number | null;
  baseSource: PayoutSource;
  congestion: CongestionState;
  /** Surcharge added on its own line; 0 unless congestion = YES */
  congestionCents: number;
  /** base + congestion when base is known */
  totalCents: number | null;
}

/**
 * Build the payout shown for a reservation. Base and surcharge are kept apart;
 * the surcharge is added exactly once and only when congestion = YES on a
 * congestion-eligible destination.
 */
export function payoutBreakdown(args: {
  correctedCents?: number | null;
  calendarCents?: number | null;
  presetCents?: number | null;
  assumePresetWhenMissing: boolean;
  congestion: CongestionState;
  congestionEligible: boolean;
  surchargeCents: number;
}): PayoutBreakdown {
  let baseCents: number | null = null;
  let baseSource: PayoutSource = 'UNKNOWN';
  if (args.correctedCents != null) {
    baseCents = args.correctedCents;
    baseSource = 'CORRECTED';
  } else if (args.calendarCents != null) {
    baseCents = args.calendarCents;
    baseSource = 'CALENDAR';
  } else if (args.assumePresetWhenMissing && args.presetCents != null && args.presetCents > 0) {
    // A $0 preset (e.g. "Other / General Trips") means "no standard rate": stays UNKNOWN.
    baseCents = args.presetCents;
    baseSource = 'ASSUMED_PRESET';
  }
  const congestion: CongestionState = args.congestionEligible ? args.congestion : 'NO';
  const congestionCents = congestion === 'YES' ? args.surchargeCents : 0;
  return {
    baseCents,
    baseSource,
    congestion,
    congestionCents,
    totalCents: baseCents === null ? null : baseCents + congestionCents,
  };
}
