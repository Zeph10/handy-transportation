import { parseReservation } from './parser.ts';
import type { CalendarEventLike, ParsedReservation, ParserConfig } from './parser.ts';

/**
 * Turn Google Calendar API events into rows for public.sync_apply().
 * Pure: no network, no database. The Edge Function fetches events, calls
 * this, and sends the rows in one RPC so the upsert is atomic.
 */

export interface GoogleEvent extends CalendarEventLike {
  etag?: string;
  updated?: string;
  iCalUID?: string;
  recurringEventId?: string;
  originalStartTime?: { dateTime?: string; date?: string };
}

export interface ReservationRow {
  google_event_id: string;
  ical_uid: string | null;
  recurring_event_id: string | null;
  original_start: string | null;
  etag: string | null;
  google_updated_at: string | null;
  source_status: string;
  raw_summary: string | null;
  raw_description: string | null;
  raw_location: string | null;
  attendee_emails: string[];
  start_at: string | null;
  end_at: string | null;
  all_day: boolean;
  parsed: ParsedReservation | Record<string, never>;
  parser_version: number;
  is_reservation: boolean;
  trip_ref: string | null;
  destination_code: string | null;
  passengers: number | null;
  checked_bags: number | null;
  assignment: ParsedReservation['assignment'];
  assigned_driver_id: string | null;
  congestion: ParsedReservation['congestion'];
  payout_cents: number | null;
  review_flags: string[];
}

function iso(v: { dateTime?: string | null; date?: string | null } | null | undefined): string | null {
  if (!v) return null;
  if (v.dateTime) {
    const t = Date.parse(v.dateTime);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  return null;
}

export function eventToRow(ev: GoogleEvent, config: ParserConfig): ReservationRow {
  const status = ev.status ?? 'confirmed';
  const cancelled = status === 'cancelled';
  // Cancelled events from the API carry almost no fields; never parse them.
  const parsed = cancelled ? null : parseReservation(ev, config);
  return {
    google_event_id: ev.id,
    ical_uid: ev.iCalUID ?? null,
    recurring_event_id: ev.recurringEventId ?? null,
    original_start: iso(ev.originalStartTime),
    etag: ev.etag ?? null,
    google_updated_at: ev.updated ? new Date(Date.parse(ev.updated)).toISOString() : null,
    source_status: status,
    raw_summary: ev.summary ?? null,
    raw_description: ev.description ?? null,
    raw_location: ev.location ?? null,
    attendee_emails: (ev.attendees ?? []).map((a) => a.email?.toLowerCase()).filter((e): e is string => !!e),
    start_at: iso(ev.start),
    end_at: iso(ev.end),
    all_day: !!(ev.start?.date && !ev.start?.dateTime),
    parsed: parsed ?? {},
    parser_version: parsed?.parserVersion ?? 0,
    is_reservation: parsed?.isReservation ?? false,
    trip_ref: parsed?.tripRef ?? null,
    destination_code: parsed?.destinationCode ?? null,
    passengers: parsed?.passengers ?? null,
    checked_bags: parsed?.checkedBags ?? null,
    assignment: parsed?.assignment ?? 'NOT_A_RESERVATION',
    assigned_driver_id: parsed?.assignedDriverId ?? null,
    congestion: parsed?.congestion ?? 'UNKNOWN',
    payout_cents: parsed?.payoutCents ?? null,
    review_flags: parsed?.reviewFlags ?? [],
  };
}

/** Map a parser config as returned by public.sync_parser_config() (JSON) into ParserConfig. */
export function parserConfigFromJson(json: {
  markers: { source: string; pattern: string }[];
  rules: { field: string; source: string; pattern: string; priority: number; enabled: boolean }[];
  rates: { pattern: string; destinationCode: string; congestion: string | null; priority: number }[];
  drivers: { driverId: string; fullName: string; email: string | null; aliases: string[] }[];
}): ParserConfig {
  return {
    markers: json.markers as ParserConfig['markers'],
    rules: json.rules as ParserConfig['rules'],
    rates: json.rates as ParserConfig['rates'],
    drivers: json.drivers,
  };
}
