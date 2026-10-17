// POST (admin only) → { url } to send the admin to Google's consent screen.
// Creates a single-use state nonce + PKCE verifier (valid 10 minutes).
import { corsHeaders, handleError, json, randomToken, requireAdmin, serviceRest, sha256Base64url } from '../_shared/http.ts';
import { authorizationUrl } from '../_shared/google.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, 405, { error: 'METHOD', message: 'Use POST.' });
  try {
    const { userId } = await requireAdmin(req);
    const nonce = randomToken(32);
    const verifier = randomToken(48);
    // Clean up expired states, then store this one.
    await serviceRest(`oauth_states?created_at=lt.${encodeURIComponent(new Date(Date.now() - 10 * 60_000).toISOString())}`, { method: 'DELETE' });
    await serviceRest('oauth_states', { method: 'POST', body: JSON.stringify({ nonce, admin_id: userId, code_verifier: verifier }) });
    return json(req, 200, { url: authorizationUrl(nonce, await sha256Base64url(verifier)) });
  } catch (e) {
    return handleError(req, e);
  }
});
