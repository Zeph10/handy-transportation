// POST (admin only): read-only refresh of the reservations calendar.
// 1. sync_begin (refuses if another sync is running)
// 2. refresh Google access token from Vault
// 3. fetch every event instance in the window (incl. cancelled)
// 4. parse with the shared core using the admin-editable rules
// 5. sync_apply (one atomic upsert), sync_finish
// Nothing is ever written to Google.
import { AppError, corsHeaders, handleError, json, requireAdmin, rpc } from '../_shared/http.ts';
import { accessTokenFromRefresh, listEvents } from '../_shared/google.ts';
import { eventToRow, parserConfigFromJson } from '../_shared/core/sync.ts';
import type { GoogleEvent } from '../_shared/core/sync.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, 405, { error: 'METHOD', message: 'Use POST.' });
  let runId: string | null = null;
  try {
    const { userId } = await requireAdmin(req);
    const run = await rpc<{ run_id: string; connection_id: string; calendar_id: string; window_start: string; window_end: string }>(
      'sync_begin', { p_started_by: userId }, 'service');
    runId = run.run_id;

    const refresh = await rpc<string | null>('sync_get_refresh_token', { p_connection: run.connection_id }, 'service');
    if (!refresh) throw new AppError('GOOGLE_EXPIRED', 'Google authorization is missing. Reconnect Google Calendar.');
    const token = await accessTokenFromRefresh(refresh);

    const events = (await listEvents(token, run.calendar_id, new Date(run.window_start).toISOString(), new Date(run.window_end).toISOString())) as GoogleEvent[];
    const config = parserConfigFromJson(await rpc('sync_parser_config', {}, 'service'));
    const rows = events.filter((e) => e && typeof e.id === 'string').map((e) => eventToRow(e, config));

    const counts = await rpc<Record<string, number>>('sync_apply', { p_run: runId, p_rows: rows }, 'service');
    await rpc('sync_finish', { p_run: runId, p_ok: true }, 'service');
    return json(req, 200, { ok: true, events: rows.length, ...counts });
  } catch (e) {
    if (runId) {
      const expired = e instanceof AppError && e.code === 'GOOGLE_EXPIRED';
      const message = e instanceof AppError ? e.message : 'Unexpected error during sync.';
      try {
        await rpc('sync_finish', { p_run: runId, p_ok: false, p_error: message, p_auth_expired: expired }, 'service');
      } catch (finishError) {
        console.error('sync_finish failed', finishError);
      }
    }
    return handleError(req, e);
  }
});
