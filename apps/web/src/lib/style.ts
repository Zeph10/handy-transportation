// One place for the colours used across calendars, legends and badges.
// Every status also has a text label or pattern, so colour is never the only cue.

export const STATUS_STYLE = {
  AVAILABLE: { label: 'Available', bg: '#16a34a', fg: '#ffffff', soft: 'rgba(22,163,74,0.15)' },
  TENTATIVE: { label: 'Tentative', bg: '#d97706', fg: '#ffffff', soft: 'rgba(217,119,6,0.15)' },
  UNAVAILABLE: { label: 'Unavailable', bg: '#64748b', fg: '#ffffff', soft: 'rgba(100,116,139,0.25)' },
  UNKNOWN: { label: 'Unknown (not submitted)', bg: 'transparent', fg: 'inherit', soft: 'transparent' },
} as const;

export const RESERVATION_STYLE = {
  IMPORTED: { label: 'Reservation', bg: '#7c3aed', fg: '#ffffff' },
  UNFILLED: { label: 'Unfilled reservation', bg: '#dc2626', fg: '#ffffff' },
  ASSIGNED: { label: 'Assigned reservation', bg: '#2563eb', fg: '#ffffff' },
  CONFLICT: { label: 'Conflict', bg: '#b91c1c', fg: '#ffffff' },
} as const;

const DEST_COLORS: Record<string, string> = {
  EWR: '#0d9488',
  LGA: '#4f46e5',
  JFK: '#ea580c',
  NYC: '#e11d48',
  OTHER: '#475569',
};
const FALLBACK = ['#0891b2', '#9333ea', '#65a30d', '#c026d3', '#0284c7', '#a16207'];

export function destinationColor(code: string): string {
  if (DEST_COLORS[code]) return DEST_COLORS[code];
  let h = 0;
  for (const ch of code) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK[h % FALLBACK.length];
}

export const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const WEEKDAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
