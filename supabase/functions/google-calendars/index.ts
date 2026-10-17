// POST (admin only) → { calendars: [{id, summary, primary}] } so the admin can choose the reservations calendar.
import { corsHeaders, handleError, json, requireAdmin, rpc, serviceRest } from '../_shared/http.ts';
import { accessTokenFromRefresh, listCalendars } from '../_shared/google.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, 405, { error: 'METHOD', message: 'Use POST.' });
  try {
    await requireAdmin(req);
    const conns = await serviceRest<{ id: string }[]>('calendar_connections?status=neq.DISCONNECTED&select=id');
    if (!conns[0]) return json(req, 404, { error: 'NOT_FOUND', message: 'Connect Google Calendar first.' });
    const refresh = await rpc<string | null>('sync_get_refresh_token', { p_connection: conns[0].id }, 'service');
    if (!refresh) return json(req, 409, { error: 'GOOGLE_EXPIRED', message: 'Reconnect Google Calendar.' });
    const token = await accessTokenFromRefresh(refresh);
    const calendars = (await listCalendars(token)).map((c) => ({ id: c.id, summary: c.summary, primary: !!c.primary, accessRole: c.accessRole }));
    return json(req, 200, { calendars });
  } catch (e) {
    return handleError(req, e);
  }
});
