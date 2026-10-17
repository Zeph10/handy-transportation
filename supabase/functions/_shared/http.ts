// Shared helpers for Edge Functions. Dependency-free: plain fetch against
// Supabase's REST and Auth endpoints, so nothing needs installing.

export function env(name: string, required = true): string {
  const v = Deno.env.get(name);
  if (!v && required) throw new Error(`Missing environment variable ${name}`);
  return v ?? '';
}

/** First value of a Supabase JSON key map env var such as SUPABASE_SECRET_KEYS ({"default":"sb_secret_…"}). */
function firstKeyFromJson(name: string): string {
  const raw = Deno.env.get(name);
  if (!raw) return '';
  try {
    const obj = JSON.parse(raw) as Record<string, string>;
    return obj.default ?? Object.values(obj)[0] ?? '';
  } catch {
    return '';
  }
}

/**
 * Project URL. Supabase injects SUPABASE_URL; as a fallback it is derived from
 * SUPABASE_DB_URL (db.<ref>.supabase.co or postgres.<ref>@…pooler).
 */
export function supabaseUrl(): string {
  const direct = Deno.env.get('SUPABASE_URL');
  if (direct) return direct.replace(/\/$/, '');
  const db = Deno.env.get('SUPABASE_DB_URL') ?? '';
  const m = /@db\.([a-z0-9]{20})\.supabase\.co/.exec(db) ?? /\/\/postgres\.([a-z0-9]{20})[:@]/.exec(db);
  if (m) return `https://${m[1]}.supabase.co`;
  throw new Error('Missing environment variable SUPABASE_URL');
}

/** Server key: legacy service_role JWT, or the newer sb_secret_… key. */
export function serviceKey(): string {
  const k = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || firstKeyFromJson('SUPABASE_SECRET_KEYS');
  if (!k) throw new Error('Missing environment variable SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SECRET_KEYS');
  return k;
}

/** Public key: legacy anon JWT, or the newer sb_publishable_… key. */
export function publicKey(): string {
  const k = Deno.env.get('SUPABASE_ANON_KEY') || firstKeyFromJson('SUPABASE_PUBLISHABLE_KEYS');
  if (!k) throw new Error('Missing environment variable SUPABASE_ANON_KEY / SUPABASE_PUBLISHABLE_KEYS');
  return k;
}

const isJwt = (k: string) => k.split('.').length === 3;

/**
 * Headers for calling Supabase APIs as the service role. New sb_secret_ keys
 * are not JWTs and go in `apikey` only; legacy keys also go in Authorization.
 */
export function serviceHeaders(): Record<string, string> {
  const key = serviceKey();
  return isJwt(key) ? { apikey: key, Authorization: `Bearer ${key}` } : { apikey: key };
}

export function corsHeaders(req: Request): Record<string, string> {
  const allowed = env('APP_URL').replace(/\/$/, '');
  const origin = req.headers.get('origin') ?? '';
  return {
    'Access-Control-Allow-Origin': origin === allowed ? origin : allowed,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

export function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(req) },
  });
}

/** Error raised by a Postgres function ("CODE: message"). */
export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

function parsePgError(text: string, status: number): AppError {
  try {
    const body = JSON.parse(text) as { message?: string };
    const m = /^([A-Z_]+):\s*(.*)$/s.exec(body.message ?? '');
    if (m) return new AppError(m[1], m[2], status === 401 || status === 403 ? status : 400);
    return new AppError('DB_ERROR', body.message ?? text, status);
  } catch {
    return new AppError('DB_ERROR', text, status);
  }
}

/** Call a Postgres function. `as` = 'service' uses the service-role key; otherwise the caller's JWT. */
export async function rpc<T>(name: string, args: Record<string, unknown>, as: 'service' | { jwt: string }): Promise<T> {
  const url = `${supabaseUrl()}/rest/v1/rpc/${name}`;
  const auth = as === 'service' ? serviceHeaders() : { apikey: publicKey(), Authorization: `Bearer ${as.jwt}` };
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw parsePgError(text, res.status);
  return (text ? JSON.parse(text) : null) as T;
}

/** Verify the caller's Supabase session and require ADMIN. Returns the user id. */
export async function requireAdmin(req: Request): Promise<{ userId: string; jwt: string }> {
  const auth = req.headers.get('authorization') ?? '';
  const jwt = auth.replace(/^Bearer\s+/i, '');
  if (!jwt) throw new AppError('AUTH', 'Please sign in.', 401);
  const res = await fetch(`${supabaseUrl()}/auth/v1/user`, {
    headers: { apikey: publicKey(), Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) throw new AppError('AUTH', 'Your session has expired. Sign in again.', 401);
  const user = (await res.json()) as { id?: string };
  if (!user.id) throw new AppError('AUTH', 'Please sign in.', 401);
  const isAdmin = await rpc<boolean>('is_admin', {}, { jwt });
  if (!isAdmin) throw new AppError('FORBIDDEN', 'Administrator access required.', 403);
  return { userId: user.id, jwt };
}

export function handleError(req: Request, e: unknown): Response {
  if (e instanceof AppError) return json(req, e.status, { error: e.code, message: e.message });
  console.error(e);
  return json(req, 500, { error: 'INTERNAL', message: 'Something went wrong. Please try again.' });
}

export function randomToken(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return base64url(a);
}

export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Base64url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return base64url(new Uint8Array(digest));
}

/** Insert/select rows through PostgREST with the service role (used for oauth_states). */
export async function serviceRest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${supabaseUrl()}/rest/v1/${path}`, {
    ...init,
    headers: {
      ...serviceHeaders(),
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw parsePgError(text, res.status);
  return (text ? JSON.parse(text) : null) as T;
}
