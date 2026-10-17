// GET from Google's redirect (no Supabase JWT; deployed with verify_jwt = false).
// Validates the single-use state, exchanges the code with PKCE, stores the
// refresh token in Vault, then redirects the admin back to the app.
import { AppError, env, rpc, serviceRest } from '../_shared/http.ts';
import { exchangeCode, listCalendars } from '../_shared/google.ts';

function back(status: 'connected' | 'error', message?: string): Response {
  const url = new URL(`${env('APP_URL').replace(/\/$/, '')}/admin/integrations`);
  url.searchParams.set('google', status);
  if (message) url.searchParams.set('message', message.slice(0, 300));
  return new Response(null, { status: 303, headers: { Location: url.toString(), 'Cache-Control': 'no-store' } });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code') ?? '';
  const googleError = url.searchParams.get('error');
  if (googleError) return back('error', googleError === 'access_denied' ? 'Google access was not granted.' : `Google returned: ${googleError}`);
  if (!state || !code) return back('error', 'Missing authorization code.');
  try {
    // Consume the state exactly once (PATCH ... where used_at is null returns the row only the first time).
    const rows = await serviceRest<{ admin_id: string; code_verifier: string; created_at: string }[]>(
      `oauth_states?nonce=eq.${encodeURIComponent(state)}&used_at=is.null`,
      { method: 'PATCH', body: JSON.stringify({ used_at: new Date().toISOString() }) },
    );
    const row = rows[0];
    if (!row) throw new AppError('STATE', 'This sign-in link was already used or is invalid. Start again from Integrations.');
    if (Date.now() - Date.parse(row.created_at) > 10 * 60_000) throw new AppError('STATE', 'The sign-in took too long. Start again from Integrations.');

    const { refreshToken, accessToken, scopes } = await exchangeCode(code, row.code_verifier);
    let accountEmail: string | null = null;
    try {
      const cals = await listCalendars(accessToken);
      accountEmail = cals.find((c) => c.primary)?.id ?? null;
    } catch {
      // Listing is only used to show which account was connected.
    }
    await rpc('store_calendar_connection', {
      p_admin: row.admin_id, p_account_email: accountEmail, p_scopes: scopes, p_refresh_token: refreshToken,
    }, 'service');
    return back('connected');
  } catch (e) {
    const msg = e instanceof AppError ? e.message : 'Connecting Google Calendar failed. Please try again.';
    if (!(e instanceof AppError)) console.error(e);
    return back('error', msg);
  }
});
