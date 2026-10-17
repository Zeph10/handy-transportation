// Google OAuth 2.0 + Calendar API (read-only). Plain fetch, no SDK.
import { AppError, env } from './http.ts';

/** Narrowest scopes that work: read events, and list calendars so the admin can pick one. */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
];

const FORBIDDEN_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
];

export function redirectUri(): string {
  return `${env('SUPABASE_URL')}/functions/v1/google-oauth-callback`;
}

export function authorizationUrl(state: string, codeChallenge: string): string {
  const p = new URLSearchParams({
    client_id: env('GOOGLE_CLIENT_ID'),
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent', // always return a refresh token
    include_granted_scopes: 'false',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export async function exchangeCode(code: string, codeVerifier: string): Promise<{ refreshToken: string; accessToken: string; scopes: string[] }> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      code_verifier: codeVerifier,
      client_id: env('GOOGLE_CLIENT_ID'),
      client_secret: env('GOOGLE_CLIENT_SECRET'),
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
    }),
  });
  const body = (await res.json()) as TokenResponse;
  if (!res.ok || !body.access_token) {
    throw new AppError('GOOGLE_AUTH', `Google sign-in failed: ${body.error_description ?? body.error ?? res.status}`);
  }
  const scopes = (body.scope ?? '').split(' ').filter(Boolean);
  if (!scopes.includes(GOOGLE_SCOPES[0])) {
    throw new AppError('GOOGLE_SCOPE', 'Calendar read access was not granted. Connect again and allow "See events on your calendars".');
  }
  if (scopes.some((s) => FORBIDDEN_SCOPES.includes(s))) {
    throw new AppError('GOOGLE_SCOPE', 'Google granted broader access than requested. Remove the app in your Google account permissions and connect again.');
  }
  if (!body.refresh_token) {
    throw new AppError('GOOGLE_AUTH', 'Google did not return a refresh token. Remove the app in your Google account permissions and connect again.');
  }
  return { refreshToken: body.refresh_token, accessToken: body.access_token, scopes };
}

/** Get a short-lived access token. Throws AppError('GOOGLE_EXPIRED') when the refresh token is no longer valid. */
export async function accessTokenFromRefresh(refreshToken: string): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env('GOOGLE_CLIENT_ID'),
      client_secret: env('GOOGLE_CLIENT_SECRET'),
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const body = (await res.json()) as TokenResponse;
  if (!res.ok || !body.access_token) {
    if (body.error === 'invalid_grant' || res.status === 400 || res.status === 401) {
      throw new AppError('GOOGLE_EXPIRED', 'Google authorization has expired or was revoked. Reconnect Google Calendar.');
    }
    throw new AppError('GOOGLE_ERROR', `Google token refresh failed (${res.status}).`);
  }
  return body.access_token;
}

async function googleGet<T>(url: string, accessToken: string): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.ok) return (await res.json()) as T;
    if (res.status === 401) throw new AppError('GOOGLE_EXPIRED', 'Google authorization has expired. Reconnect Google Calendar.');
    if (res.status === 404) throw new AppError('GOOGLE_NOT_FOUND', 'The selected calendar was not found or is no longer shared with this account.');
    if (res.status === 429 || res.status >= 500 || res.status === 403) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    throw new AppError('GOOGLE_ERROR', `Google Calendar returned ${res.status}.`);
  }
  throw new AppError('GOOGLE_ERROR', 'Google Calendar is not responding. Try again shortly.');
}

export interface CalendarListEntry { id: string; summary: string; primary?: boolean; accessRole: string }

export async function listCalendars(accessToken: string): Promise<CalendarListEntry[]> {
  const out: CalendarListEntry[] = [];
  let pageToken: string | undefined;
  do {
    const p = new URLSearchParams({ maxResults: '250', ...(pageToken ? { pageToken } : {}) });
    const page = await googleGet<{ items?: CalendarListEntry[]; nextPageToken?: string }>(
      `https://www.googleapis.com/calendar/v3/users/me/calendarList?${p}`, accessToken);
    out.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

/** All event instances (recurring events expanded) in the window, including cancelled ones. */
export async function listEvents(accessToken: string, calendarId: string, timeMin: string, timeMax: string): Promise<unknown[]> {
  const out: unknown[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const p = new URLSearchParams({
      singleEvents: 'true',
      showDeleted: 'true',
      timeMin,
      timeMax,
      maxResults: '2500',
      ...(pageToken ? { pageToken } : {}),
    });
    const page = await googleGet<{ items?: unknown[]; nextPageToken?: string }>(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${p}`, accessToken);
    out.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
    if (++pages > 40) throw new AppError('GOOGLE_ERROR', 'Too many events in the sync window. Shorten the window in Settings.');
  } while (pageToken);
  return out;
}
