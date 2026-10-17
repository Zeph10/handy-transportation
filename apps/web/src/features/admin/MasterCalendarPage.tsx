import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { EventInput } from '@fullcalendar/core';
import { addDays, formatDayTime, localToInstant } from '@handy/core';
import type { AvailabilityStatus } from '@handy/core';
import { Button, Card, Checkbox, Dialog, ErrorNotice, Field, Input, Loading, Notice, PageHeader, Select, useToast } from '@/components/ui';
import { adminMarkUnavailable } from '@/lib/api';
import type { DriverSchedule } from '@/lib/convert';
import { toAppError } from '@/lib/errors';
import { effectiveDuration, findConflicts } from '@/lib/matchInputs';
import { RESERVATION_STYLE, STATUS_STYLE } from '@/lib/style';
import { BlockEditor } from '@/features/driver/BlockEditor';
import type { EditorTarget } from '@/features/driver/BlockEditor';
import { driverEvents } from '@/features/driver/availabilityEvents';
import { CalendarToolbar, CalendarView, useCalendarNav } from '@/features/calendar/CalendarView';
import { Legend } from '@/features/calendar/Legend';
import { SyncBanner } from './SyncBanner';
import { useAdminDataset } from './useAdminData';

export default function MasterCalendarPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const nav = useCalendarNav(params.get('date') ?? undefined);
  const data = useAdminDataset(nav.from, nav.to);
  const toast = useToast();

  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [statuses, setStatuses] = useState<Set<AvailabilityStatus>>(new Set(['AVAILABLE', 'TENTATIVE', 'UNAVAILABLE']));
  const [dest, setDest] = useState('');
  const [minSeats, setMinSeats] = useState(0);
  const [showAvail, setShowAvail] = useState(true);
  const [showRes, setShowRes] = useState(true);
  const [onlyUnfilled, setOnlyUnfilled] = useState(false);
  const [editor, setEditor] = useState<{ driverId: string; target: EditorTarget } | null>(null);
  const [markOpen, setMarkOpen] = useState<{ start: number; end: number } | null>(null);

  const ds = data.data;
  const drivers = useMemo(() => (ds?.drivers ?? []).filter((d) => d.status === 'APPROVED'), [ds]);

  const events = useMemo<EventInput[]>(() => {
    if (!ds) return [];
    const out: EventInput[] = [];
    const vehicleSeats = new Map(ds.vehicles.map((v) => [v.id, v.max_passengers]));
    const keep = (status: AvailabilityStatus, vehicleId: string | null, dests: { destinationId: string }[]) =>
      statuses.has(status) &&
      (status === 'UNAVAILABLE' || !dest || dests.some((d) => d.destinationId === dest)) &&
      (status === 'UNAVAILABLE' || !minSeats || (vehicleId ? (vehicleSeats.get(vehicleId) ?? 0) >= minSeats : false));
    if (showAvail) {
      for (const d of drivers) {
        if (hidden.has(d.user_id)) continue;
        const s = ds.schedules.get(d.user_id);
        if (!s) continue;
        const filtered: DriverSchedule = {
          ...s,
          blocks: s.blocks.filter((b) => keep(b.status, b.vehicleId, b.destinations)),
          rules: s.rules.filter((r) => keep(r.status, r.vehicleId, r.destinations)),
        };
        out.push(...driverEvents(filtered, nav.from, nav.to, {
          vehicles: ds.vehicles, destinations: ds.destinations, pendingTargets: new Set(),
          adminBlockIds: new Set(data.data!.scheduleRows.blocks.filter((b) => b.origin === 'ADMIN').map((b) => b.id)),
          prefix: (d.full_name || d.email).split(' ')[0], idPrefix: `${d.user_id}|`,
        }));
      }
    }
    if (showRes) {
      const conflicts = findConflicts(ds);
      const name = (id: string | null) => ds.drivers.find((d) => d.user_id === id)?.full_name;
      for (const r of ds.reservations) {
        if (!r.pickup_at || r.removed_from_source) continue;
        if (!r.is_reservation) continue;
        if (onlyUnfilled && r.assignment !== 'UNFILLED') continue;
        const dur = effectiveDuration(r, ds.destinations).minutes ?? 60;
        const start = Date.parse(r.pickup_at);
        const conflict = conflicts.get(r.id);
        const style = conflict ? RESERVATION_STYLE.CONFLICT
          : r.assignment === 'UNFILLED' ? RESERVATION_STYLE.UNFILLED
          : r.assignment === 'ASSIGNED' ? RESERVATION_STYLE.ASSIGNED : RESERVATION_STYLE.IMPORTED;
        const label = r.assignment === 'UNFILLED' ? 'UNFILLED' : r.assignment === 'ASSIGNED' ? name(r.assigned_driver_id) ?? 'Assigned' : 'Review';
        out.push({
          id: `res|${r.id}`,
          start,
          end: start + dur * 60_000,
          title: `${conflict ? '⚠ ' : ''}${label} · ${r.destination_code ?? '?'} · ${r.passengers ?? '?'} pax${r.trip_ref ? ` · ${r.trip_ref}` : ''}`,
          backgroundColor: style.bg,
          borderColor: conflict ? '#fde047' : style.bg,
          textColor: style.fg,
          extendedProps: { kind: 'reservation', reservationId: r.id, conflict },
        });
      }
    }
    return out;
  }, [ds, drivers, hidden, statuses, dest, minSeats, showAvail, showRes, onlyUnfilled, nav.from, nav.to, data.data]);

  const onEvent = (id: string, p: Record<string, unknown>) => {
    if (!ds) return;
    if (p.kind === 'reservation') { navigate(`/admin/reservations/${String(p.reservationId)}`); return; }
    const driverId = id.split('|')[0];
    const s = ds.schedules.get(driverId);
    if (!s) return;
    if (p.kind === 'block') {
      const b = s.blocks.find((x) => x.id === p.blockId);
      const row = ds.scheduleRows.blocks.find((x) => x.id === p.blockId);
      if (b && row) setEditor({ driverId, target: { kind: 'block', block: b, version: row.version } });
    } else if (p.kind === 'occurrence') {
      const rule = s.rules.find((r) => r.id === p.ruleId);
      if (!rule) return;
      const date = String(p.occurrenceDate);
      setEditor({ driverId, target: { kind: 'occurrence', occurrence: {
        ruleId: rule.id, occurrenceDate: date, status: rule.status, vehicleId: rule.vehicleId, destinations: rule.destinations,
        start: localToInstant(date, rule.localStart), end: localToInstant(addDays(date, rule.endDayOffset), rule.localEnd),
      } } });
    }
  };

  return (
    <div className="space-y-3">
      <PageHeader title="Master calendar" subtitle="Every driver's availability with Google Calendar reservations on top. Select a time range to mark a driver unavailable." />
      <SyncBanner />
      <div className="grid gap-3 xl:grid-cols-[18rem_1fr]">
        <Card className="space-y-4 self-start">
          <div>
            <p className="mb-1 text-sm font-semibold">Layers</p>
            <Checkbox label="Driver availability" checked={showAvail} onChange={setShowAvail} />
            <Checkbox label="Reservations" checked={showRes} onChange={setShowRes} />
            <Checkbox label="Only unfilled reservations" checked={onlyUnfilled} onChange={setOnlyUnfilled} disabled={!showRes} />
          </div>
          <div>
            <p className="mb-1 text-sm font-semibold">Status</p>
            {(['AVAILABLE', 'TENTATIVE', 'UNAVAILABLE'] as const).map((s) => (
              <Checkbox key={s} label={STATUS_STYLE[s].label} checked={statuses.has(s)}
                onChange={(v) => setStatuses((cur) => { const n = new Set(cur); if (v) n.add(s); else n.delete(s); return n; })} />
            ))}
          </div>
          <Field label="Destination" htmlFor="f-dest">
            <Select id="f-dest" value={dest} onChange={(e) => setDest(e.target.value)}>
              <option value="">Any</option>
              {(ds?.destinations ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
          </Field>
          <Field label="Minimum seats" htmlFor="f-seats">
            <Input id="f-seats" type="number" min={0} max={60} value={minSeats || ''} placeholder="Any" onChange={(e) => setMinSeats(Number(e.target.value) || 0)} />
          </Field>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <p className="text-sm font-semibold">Drivers</p>
              <span className="flex gap-1">
                <Button variant="ghost" size="sm" onClick={() => setHidden(new Set())}>All</Button>
                <Button variant="ghost" size="sm" onClick={() => setHidden(new Set(drivers.map((d) => d.user_id)))}>None</Button>
              </span>
            </div>
            <div className="max-h-72 overflow-y-auto">
              {drivers.map((d) => (
                <Checkbox key={d.user_id} label={d.full_name || d.email} checked={!hidden.has(d.user_id)}
                  onChange={(v) => setHidden((cur) => { const n = new Set(cur); if (v) n.delete(d.user_id); else n.add(d.user_id); return n; })} />
              ))}
            </div>
          </div>
        </Card>
        <div className="min-w-0">
          <CalendarToolbar nav={nav} />
          {data.isLoading ? <Loading /> : data.error ? <ErrorNotice error={data.error} onRetry={() => void data.refetch()} /> : (
            <CalendarView nav={nav} events={events} onEventClick={onEvent} onSelect={(start, end) => setMarkOpen({ start, end })} height="80dvh" />
          )}
          <div className="mt-3"><Legend reservations /></div>
        </div>
      </div>

      {editor && (
        <BlockEditor driverId={editor.driverId} target={editor.target} mode={{ as: 'admin' }} onClose={() => setEditor(null)}
          congestionCents={ds?.settings.congestion_surcharge_cents} />
      )}
      <MarkUnavailableDialog range={markOpen} drivers={drivers.map((d) => ({ id: d.user_id, name: d.full_name || d.email }))}
        onClose={() => setMarkOpen(null)}
        onSave={async (driverId, reason) => {
          try {
            await adminMarkUnavailable(driverId, markOpen!.start, markOpen!.end, reason);
            toast('success', 'Driver marked unavailable (their own entries are unchanged)');
            setMarkOpen(null);
            await data.refetch();
          } catch (e) { toast('error', toAppError(e).message); }
        }} />
    </div>
  );
}

function MarkUnavailableDialog({ range, drivers, onClose, onSave }: {
  range: { start: number; end: number } | null; drivers: { id: string; name: string }[];
  onClose: () => void; onSave: (driverId: string, reason: string) => Promise<void>;
}) {
  const [driverId, setDriverId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={!!range} onClose={onClose} title="Mark a driver unavailable"
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button disabled={!driverId || reason.trim().length < 3} loading={busy} onClick={async () => { setBusy(true); await onSave(driverId, reason.trim()); setBusy(false); }}>Mark unavailable</Button></>}>
      {range && (
        <div className="space-y-4">
          <p className="text-sm">{formatDayTime(range.start)} – {formatDayTime(range.end)}</p>
          <Notice>This adds an "unavailable" layer on top. The driver's own availability is kept and they can see this change.</Notice>
          <Field label="Driver" htmlFor="mu-driver"><Select id="mu-driver" value={driverId} onChange={(e) => setDriverId(e.target.value)}>
            <option value="">Choose…</option>{drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select></Field>
          <Field label="Reason" htmlFor="mu-reason" help="Recorded in the audit log and shown to the driver."><Input id="mu-reason" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} /></Field>
        </div>
      )}
    </Dialog>
  );
}
