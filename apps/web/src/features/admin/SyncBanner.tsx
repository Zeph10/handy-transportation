import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { formatDayTime } from '@handy/core';
import { Button, Notice, useToast } from '@/components/ui';
import { runCalendarSync } from '@/lib/api';
import { toAppError } from '@/lib/errors';
import { useSyncStatus } from './useAdminData';

function ago(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/** Last successful sync, a Sync now button, and a clear stale/expired warning. */
export function SyncBanner() {
  const status = useSyncStatus();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const s = status.data;
  const conn = s?.connection;

  const sync = async () => {
    setBusy(true);
    try {
      const r = await runCalendarSync();
      toast('success', `Synced ${r.events} events: ${r.inserted} new, ${r.updated} changed, ${r.removed} removed`);
      await Promise.all([qc.invalidateQueries({ queryKey: ['sync-status'] }), qc.invalidateQueries({ queryKey: ['admin-dataset'] }), qc.invalidateQueries({ queryKey: ['reservation'] })]);
    } catch (e) {
      toast('error', toAppError(e).message);
      await qc.invalidateQueries({ queryKey: ['sync-status'] });
    } finally { setBusy(false); }
  };

  if (!s) return null;
  if (!conn || conn.status === 'DISCONNECTED') {
    return <Notice tone="warn">Google Calendar is not connected, so reservations are not shown. <Link className="font-semibold underline" to="/admin/integrations">Connect it</Link>.</Notice>;
  }
  const last = conn.last_success_at;
  return (
    <div className="flex flex-wrap items-center gap-3">
      {conn.status === 'EXPIRED' ? (
        <Notice tone="error">Google authorization expired. Reservations below are from the last sync{last ? ` (${formatDayTime(Date.parse(last))})` : ''} and may be out of date. <Link className="font-semibold underline" to="/admin/integrations">Reconnect</Link>.</Notice>
      ) : s.stale ? (
        <Notice tone="warn">Reservations may be out of date: last successful sync {last ? `${formatDayTime(Date.parse(last))} (${ago(last)})` : 'never'}.{s.last_run?.status === 'FAILED' && s.last_run.error ? ` Last attempt failed: ${s.last_run.error}` : ''}</Notice>
      ) : (
        <p className="text-sm text-[var(--muted)]">Reservations synced {last ? `${formatDayTime(Date.parse(last))} (${ago(last)})` : 'never'}</p>
      )}
      <Button variant="outline" size="sm" onClick={() => void sync()} loading={busy || s.running} disabled={conn.status === 'EXPIRED' || !conn.calendar_id}>
        {s.running ? 'Syncing…' : 'Sync now'}
      </Button>
    </div>
  );
}
