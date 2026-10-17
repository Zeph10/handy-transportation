import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDayTime, formatUSD } from '@handy/core';
import { Badge, Button, Card, ErrorNotice, Field, Loading, Notice, PageHeader, Textarea, useToast } from '@/components/ui';
import { addAdminNote, listAdminNotes, listAudit, listDestinationDefaults, listDestinations, listDrivers, listVehicles, setDriverStatus } from '@/lib/api';
import { toAppError } from '@/lib/errors';
import { describeChange } from '@/lib/describe';
import { useSession } from '@/features/auth/session';
import { useDriverReference } from '@/features/driver/hooks';
import { driverEvents } from '@/features/driver/availabilityEvents';
import { BlockEditor } from '@/features/driver/BlockEditor';
import type { EditorTarget } from '@/features/driver/BlockEditor';
import { useSchedule } from '@/features/driver/hooks';
import { CalendarToolbar, CalendarView, useCalendarNav } from '@/features/calendar/CalendarView';
import { STATUS_BADGE } from './DriversPage';

export default function DriverDetailPage() {
  const { id } = useParams();
  const driverId = id!;
  const { userId } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const drivers = useQuery({ queryKey: ['drivers'], queryFn: listDrivers });
  const vehicles = useQuery({ queryKey: ['vehicles', driverId, 'all'], queryFn: () => listVehicles(driverId, true) });
  const defaults = useQuery({ queryKey: ['dest-defaults', driverId], queryFn: () => listDestinationDefaults(driverId) });
  const destinations = useQuery({ queryKey: ['destinations-all'], queryFn: () => listDestinations(true) });
  const notes = useQuery({ queryKey: ['admin-notes', driverId], queryFn: () => listAdminNotes(driverId) });
  const audit = useQuery({ queryKey: ['audit', driverId], queryFn: () => listAudit({ driverId, limit: 30 }) });
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [target, setTarget] = useState<EditorTarget | null>(null);
  const nav = useCalendarNav();
  const sched = useSchedule(driverId, nav.from, nav.to);
  const ref = useDriverReference(driverId);
  const d = drivers.data?.find((x) => x.user_id === driverId);

  const events = useMemo(() => sched.data ? driverEvents(sched.data.schedule, nav.from, nav.to, {
    vehicles: ref.vehicles, destinations: ref.destinations, pendingTargets: new Set(),
    adminBlockIds: new Set(sched.data.rows.blocks.filter((b) => b.origin === 'ADMIN').map((b) => b.id)),
  }) : [], [sched.data, nav.from, nav.to, ref.vehicles, ref.destinations]);

  const status = async (s: 'APPROVED' | 'REJECTED' | 'SUSPENDED') => {
    const reason = s === 'APPROVED' ? undefined : window.prompt(`Reason (optional, the driver sees it):`) ?? undefined;
    setBusy(s);
    try { await setDriverStatus(driverId, s, reason); toast('success', `Driver ${STATUS_BADGE[s].label.toLowerCase()}`); await qc.invalidateQueries({ queryKey: ['drivers'] }); }
    catch (e) { toast('error', toAppError(e).message); }
    finally { setBusy(null); }
  };
  const saveNote = async () => {
    if (!note.trim() || !userId) return;
    try { await addAdminNote(driverId, note.trim(), userId); setNote(''); await qc.invalidateQueries({ queryKey: ['admin-notes', driverId] }); toast('success', 'Note saved'); }
    catch (e) { toast('error', toAppError(e).message); }
  };
  const openEvent = (_id: string, p: Record<string, unknown>) => {
    if (!sched.data) return;
    if (p.kind === 'block') {
      const b = sched.data.schedule.blocks.find((x) => x.id === p.blockId);
      const row = sched.data.rows.blocks.find((x) => x.id === p.blockId);
      if (b && row) setTarget({ kind: 'block', block: b, version: row.version });
    }
  };

  if (drivers.isLoading) return <Loading />;
  if (drivers.error) return <ErrorNotice error={drivers.error} />;
  if (!d) return <Notice tone="error">Driver not found.</Notice>;

  return (
    <div className="space-y-4">
      <PageHeader title={d.full_name || d.email} subtitle={<><Badge tone={STATUS_BADGE[d.status].tone}>{STATUS_BADGE[d.status].label}</Badge> {d.email}{d.phone ? ` · ${d.phone}` : ''}</>}
        actions={<>
          {d.status !== 'APPROVED' && <Button onClick={() => void status('APPROVED')} loading={busy === 'APPROVED'}>{d.status === 'SUSPENDED' ? 'Reactivate' : 'Approve'}</Button>}
          {d.status === 'PENDING_APPROVAL' && <Button variant="outline" onClick={() => void status('REJECTED')} loading={busy === 'REJECTED'}>Reject</Button>}
          {d.status === 'APPROVED' && d.user_id !== userId && <Button variant="outline" onClick={() => void status('SUSPENDED')} loading={busy === 'SUSPENDED'}>Suspend</Button>}
        </>} />
      {d.status_reason && <Notice>Status note: {d.status_reason}</Notice>}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Vehicles">
          {(vehicles.data ?? []).length === 0 ? <p className="text-sm text-[var(--muted)]">None yet.</p> : (
            <ul className="space-y-1 text-sm">{vehicles.data!.map((v) => <li key={v.id}>{v.name}: {v.max_passengers} seats, {v.max_luggage ?? '?'} bags {v.deleted_at ? <Badge>removed</Badge> : !v.is_active ? <Badge>inactive</Badge> : null}</li>)}</ul>
          )}
        </Card>
        <Card title="Usual destinations & minimums">
          <ul className="space-y-1 text-sm">
            {(destinations.data ?? []).map((x) => {
              const def = defaults.data?.find((y) => y.destination_id === x.id);
              return <li key={x.id} className={def?.accepted ? '' : 'text-[var(--muted)] line-through'}>{x.name}: {def?.min_rate_cents != null ? formatUSD(def.min_rate_cents) : '—'}</li>;
            })}
          </ul>
        </Card>
        <Card title="Private notes (admins only)">
          <Field label="Add note" htmlFor="an-note"><Textarea id="an-note" value={note} maxLength={4000} onChange={(e) => setNote(e.target.value)} /></Field>
          <Button size="sm" className="mt-2" onClick={() => void saveNote()} disabled={!note.trim()}>Save note</Button>
          <ul className="mt-3 space-y-2 text-sm">{(notes.data ?? []).map((n) => <li key={n.id}><p className="whitespace-pre-line">{n.body}</p><p className="text-xs text-[var(--muted)]">{formatDayTime(Date.parse(n.created_at))}</p></li>)}</ul>
        </Card>
      </div>
      {d.driver_notes && <Card title="Driver's own notes"><p className="whitespace-pre-line text-sm">{d.driver_notes}</p></Card>}
      <Card title="Availability" actions={<span className="text-xs text-[var(--muted)]">Tap a block to edit. Every edit asks for a reason and is logged.</span>}>
        <CalendarToolbar nav={nav} />
        <CalendarView nav={nav} events={events} onEventClick={openEvent}
          onSelect={(s, e) => setTarget({ kind: 'new', start: s, end: e })} height="60dvh" />
      </Card>
      <Card title="Recent changes">
        <ul className="divide-y divide-[var(--border)] text-sm">
          {(audit.data ?? []).map((a) => (
            <li key={a.id} className="py-2">{describeChange(a)} <span className="text-xs text-[var(--muted)]">· {a.actor_role === 'ADMIN' ? 'by admin' : a.actor_role === 'DRIVER' ? 'by driver' : a.actor_role?.toLowerCase()} · {formatDayTime(Date.parse(a.created_at))}{a.reason ? ` · "${a.reason}"` : ''}</span></li>
          ))}
        </ul>
      </Card>
      <BlockEditor driverId={driverId} target={target} mode={{ as: 'admin' }} onClose={() => setTarget(null)} />
    </div>
  );
}
