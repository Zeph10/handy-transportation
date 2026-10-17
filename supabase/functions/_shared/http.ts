// Shared helpers for Edge Functions. Dependency-free: plain fetch against
// Supabase's REST and Auth endpoints, so nothing needs installing.

export function env(name: string, required = true): string {
  const v = Deno.env.get(name);
  if (!v && required) throw new Error(`Missing environment variable ${name}`);
  return v ?? '';
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
  const url = `${env('SUPABASE_URL')}/rest/v1/rpc/${name}`;
  const key = as === 'service' ? env('SUPABASE_SERVICE_ROLE_KEY') : env('SUPABASE_ANON_KEY');
  const bearer = as === 'service' ? key : as.jwt;
  const res = await fetch(url, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
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
  const res = await fetch(`${env('SUPABASE_URL')}/auth/v1/user`, {
    headers: { apikey: env('SUPABASE_ANON_KEY'), Authorization: `Bearer ${jwt}` },
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
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const res = await fetch(`${env('SUPABASE_URL')}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw parsePgError(text, res.status);
  return (text ? JSON.parse(text) : null) as T;
}
