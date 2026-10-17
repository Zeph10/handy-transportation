import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { formatDayTime } from '@handy/core';
import { Badge, Button, Card, Field, Loading, Notice, PageHeader, Select, useConfirm, useToast } from '@/components/ui';
import { disconnectCalendar, listGoogleCalendars, setCalendar, startGoogleConnect } from '@/lib/api';
import { toAppError } from '@/lib/errors';
import { SyncBanner } from './SyncBanner';
import { useSyncStatus } from './useAdminData';

export default function IntegrationsPage() {
  const [params, setParams] = useSearchParams();
  const status = useSyncStatus();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [cals, setCals] = useState<{ id: string; summary: string; primary: boolean }[] | null>(null);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const conn = status.data?.connection;

  useEffect(() => {
    const g = params.get('google');
    if (g === 'connected') { toast('success', 'Google Calendar connected (read-only). Now choose the reservations calendar.'); setParams({}); void qc.invalidateQueries({ queryKey: ['sync-status'] }); }
    if (g === 'error') { toast('error', params.get('message') ?? 'Connecting Google Calendar failed.'); setParams({}); }
  }, [params, setParams, toast, qc]);

  const connect = async () => {
    setBusy('connect');
    try { const { url } = await startGoogleConnect(); window.location.assign(url); }
    catch (e) { toast('error', toAppError(e).message); setBusy(null); }
  };
  const loadCalendars = async () => {
    setBusy('list');
    try { const r = await listGoogleCalendars(); setCals(r.calendars); setPick(conn?.calendar_id ?? r.calendars.find((c) => c.primary)?.id ?? ''); }
    catch (e) { toast('error', toAppError(e).message); }
    finally { setBusy(null); }
  };
  const choose = async () => {
    const c = cals?.find((x) => x.id === pick);
    if (!c) return;
    try { await setCalendar(c.id, c.summary); toast('success', `Reading reservations from "${c.summary}"`); await qc.invalidateQueries({ queryKey: ['sync-status'] }); }
    catch (e) { toast('error', toAppError(e).message); }
  };
  const disconnect = async () => {
    if (!(await confirm({ title: 'Disconnect Google Calendar?', body: 'The app forgets its Google access. Imported reservations, corrections and all driver availability are kept. You can reconnect any time.', danger: true, confirmLabel: 'Disconnect' }))) return;
    try { await disconnectCalendar(); toast('success', 'Disconnected'); await qc.invalidateQueries({ queryKey: ['sync-status'] }); }
    catch (e) { toast('error', toAppError(e).message); }
  };

  if (status.isLoading) return <Loading />;
  const connected = conn && conn.status !== 'DISCONNECTED';

  return (
    <div className="space-y-4">
      <PageHeader title="Integrations" />
      <Card title="Google Calendar (reservations)">
        <div className="space-y-3 text-sm">
          <p>Read-only access: the app can see events and the list of calendars. It never creates, edits or deletes anything in Google Calendar.</p>
          {connected ? (
            <>
              <p>Status: <Badge tone={conn!.status === 'CONNECTED' ? 'green' : 'red'}>{conn!.status === 'CONNECTED' ? 'Connected' : conn!.status === 'EXPIRED' ? 'Authorization expired' : 'Error'}</Badge> {conn!.account && <>as <strong>{conn!.account}</strong></>}</p>
              <p>Calendar: {conn!.calendar_name ? <strong>{conn!.calendar_name}</strong> : <Badge tone="amber">not chosen</Badge>} {conn!.calendar_id && <span className="text-[var(--muted)]">({conn!.calendar_id})</span>}</p>
              {conn!.last_error && <Notice tone="error">Last error: {conn!.last_error}</Notice>}
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => void loadCalendars()} loading={busy === 'list'}>Choose calendar…</Button>
                <Button variant={conn!.status === 'EXPIRED' ? 'primary' : 'outline'} onClick={() => void connect()} loading={busy === 'connect'}>Reconnect</Button>
                <Button variant="ghost" onClick={() => void disconnect()}>Disconnect</Button>
              </div>
              {cals && (
                <div className="flex flex-wrap items-end gap-2">
                  <Field label="Reservations calendar" htmlFor="g-cal"><Select id="g-cal" value={pick} onChange={(e) => setPick(e.target.value)}>
                    {cals.map((c) => <option key={c.id} value={c.id}>{c.summary}{c.primary ? ' (primary)' : ''}</option>)}
                  </Select></Field>
                  <Button onClick={() => void choose()} disabled={!pick}>Use this calendar</Button>
                </div>
              )}
            </>
          ) : (
            <Button onClick={() => void connect()} loading={busy === 'connect'}>Connect Google Calendar</Button>
          )}
        </div>
      </Card>
      {connected && <Card title="Sync"><SyncBanner />
        {status.data?.last_run && <p className="mt-3 text-sm text-[var(--muted)]">Last run {formatDayTime(Date.parse(status.data.last_run.started_at))}: {status.data.last_run.status.toLowerCase()} · {status.data.last_run.events_seen} events, {status.data.last_run.inserted} new, {status.data.last_run.updated} changed, {status.data.last_run.removed} removed{status.data.last_run.error ? ` · ${status.data.last_run.error}` : ''}</p>}
      </Card>}
    </div>
  );
}
