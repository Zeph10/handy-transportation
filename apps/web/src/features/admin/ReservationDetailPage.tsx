import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDayTime, formatTime, formatUSD, instantToLocalDate, parseDollars, todayLocal } from '@handy/core';
import type { DriverMatch } from '@handy/core';
import { Badge, Button, Card, Dialog, ErrorNotice, Field, Input, Loading, Notice, PageHeader, Select, Textarea, useToast } from '@/components/ui';
import { clearReservationCorrection, getReservation, listActiveOverrides, revokeOverride, saveReservationCorrection, setOverride } from '@/lib/api';
import { toAppError } from '@/lib/errors';
import { effectiveDuration, matchOne, reservationPayout } from '@/lib/matchInputs';
import type { ReservationEffectiveRow } from '@/lib/types';
import { SyncBanner } from './SyncBanner';
import { flagText } from './ReservationsPage';
import { useAdminDataset } from './useAdminData';

export default function ReservationDetailPage() {
  const { id } = useParams();
  // Find the reservation's local date first, then load that day's full dataset (drivers, schedules, other trips).
  const head = useQuery({ queryKey: ['reservation', id], queryFn: () => getReservation(id!), enabled: !!id });
  const day = head.data?.pickup_at ? instantToLocalDate(Date.parse(head.data.pickup_at)) : todayLocal();
  const data = useAdminDataset(day, day);
  const r = data.data?.reservations.find((x) => x.id === id) ?? head.data;

  if (head.isLoading || data.isLoading) return <Loading />;
  if (head.error) return <Notice tone="error">Reservation not found. <Link to="/admin/reservations" className="underline">Back to reservations</Link></Notice>;
  if (data.error) return <ErrorNotice error={data.error} onRetry={() => void data.refetch()} />;
  if (!r || !data.data) return null;
  return <Detail r={r} ds={data.data} />;
}

function Detail({ r, ds }: { r: ReservationEffectiveRow; ds: NonNullable<ReturnType<typeof useAdminDataset>['data']> }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [showIneligible, setShowIneligible] = useState(false);
  const [overrideFor, setOverrideFor] = useState<DriverMatch | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const result = useMemo(() => matchOne(r, ds), [r, ds]);
  const payout = reservationPayout(r, ds);
  const dur = effectiveDuration(r, ds.destinations);
  const dest = ds.destinations.find((d) => d.id === r.destination_id);
  const assigned = ds.drivers.find((d) => d.user_id === r.assigned_driver_id);
  const parsed = r.parsed as Record<string, unknown>;
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-dataset'] });

  const revoke = async (driverId: string) => {
    const ov = (await listActiveOverrides()).find((o) => o.reservation_id === r.id && o.driver_id === driverId);
    if (!ov) return;
    try { await revokeOverride(ov.id); toast('success', 'Override removed'); await refresh(); } catch (e) { toast('error', toAppError(e).message); }
  };

  const src = (s: string) => s === 'CORRECTED' ? <Badge tone="blue">corrected</Badge> : s === 'UNKNOWN' ? <Badge tone="amber">unknown</Badge> : null;

  return (
    <div className="space-y-4">
      <PageHeader title={r.trip_ref ?? 'Reservation'} subtitle={r.pickup_at ? `Pickup ${formatDayTime(Date.parse(r.pickup_at))}` : 'Pickup time unknown'}
        actions={<><Button variant="outline" onClick={() => setEditOpen(true)}>Correct details</Button><Link to="/admin/reservations"><Button variant="ghost">Back</Button></Link></>} />
      <SyncBanner />
      {r.removed_from_source && <Notice tone="warn">This event was cancelled or deleted in Google Calendar. It is kept here for the record only.</Notice>}
      {r.review_flags.length > 0 && <Notice tone="warn">Needs review: {r.review_flags.map(flagText).join('; ')}.</Notice>}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Trip" className="lg:col-span-2">
          <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-2 text-sm">
            <dt className="text-[var(--muted)]">Status</dt>
            <dd>{r.assignment === 'UNFILLED' ? <Badge tone="red">Unfilled</Badge> : r.assignment === 'ASSIGNED' ? <>Assigned to <strong>{assigned?.full_name ?? '?'}</strong> {src(r.assignment_source)}</> : r.assignment === 'ASSIGNED_UNKNOWN' ? <Badge tone="amber">Driver "{String(parsed.driverName ?? '?')}" not matched. Add an alias in Settings.</Badge> : 'Not a reservation'}</dd>
            <dt className="text-[var(--muted)]">Pickup</dt><dd>{String(parsed.pickupAddress ?? '—')}</dd>
            <dt className="text-[var(--muted)]">Drop-off</dt><dd>{String(parsed.dropoffAddress ?? '—')}</dd>
            <dt className="text-[var(--muted)]">Destination</dt><dd>{dest?.name ?? 'Unknown'} {src(r.destination_source)} {parsed.rateLabel ? <span className="text-[var(--muted)]">(rate: {String(parsed.rateLabel)})</span> : null}</dd>
            <dt className="text-[var(--muted)]">Passengers</dt><dd>{r.passengers ?? 'Unknown'} {src(r.passengers_source)}</dd>
            <dt className="text-[var(--muted)]">Bags</dt><dd>{r.checked_bags ?? '?'} checked{parsed.carryOnBags != null ? `, ${String(parsed.carryOnBags)} carry-on` : ''}</dd>
            <dt className="text-[var(--muted)]">Flight</dt><dd>{String(parsed.flight ?? '—')}</dd>
            <dt className="text-[var(--muted)]">Trip duration</dt><dd>{dur.minutes ? `${dur.minutes} min ${dur.estimate ? '(estimate)' : '(set by dispatcher)'}` : <Badge tone="amber">not set: add an estimate for {dest?.name ?? 'this destination'} in Settings</Badge>}</dd>
            {parsed.specialInstructions ? <><dt className="text-[var(--muted)]">Instructions</dt><dd className="whitespace-pre-line">{String(parsed.specialInstructions)}</dd></> : null}
            {r.correction_notes && <><dt className="text-[var(--muted)]">Dispatcher notes</dt><dd>{r.correction_notes}</dd></>}
          </dl>
        </Card>
        <Card title="Driver payout">
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between"><dt>{dest?.name ?? 'Base'}</dt><dd className="font-semibold">{payout.baseCents === null ? 'Unknown' : formatUSD(payout.baseCents)}</dd></div>
            <p className="text-xs text-[var(--muted)]">{payout.baseSource === 'ASSUMED_PRESET' ? 'Company preset (not stated on the reservation)' : payout.baseSource === 'CORRECTED' ? 'Set by dispatcher' : payout.baseSource === 'CALENDAR' ? 'From the reservation' : 'Not stated; set it with Correct details'}</p>
            {dest?.congestion_eligible && (
              <div className="flex justify-between pt-1"><dt>Congestion Pricing</dt>
                <dd>{payout.congestion === 'YES' ? `+${formatUSD(payout.congestionCents)}` : payout.congestion === 'NO' ? 'Not applicable' : <Badge tone="amber">Not determined</Badge>}</dd></div>
            )}
            {payout.totalCents !== null && payout.congestionCents > 0 && (
              <div className="flex justify-between border-t border-[var(--border)] pt-1"><dt>Total</dt><dd className="font-semibold">{formatUSD(payout.totalCents)}</dd></div>
            )}
          </dl>
          <p className="mt-3 text-xs text-[var(--muted)]">Driver payout, not the passenger's price. Drivers' minimums are compared with the base amount; congestion is paid on top.</p>
        </Card>
      </div>

      {r.is_reservation && !r.removed_from_source && (
        <Card title="Driver eligibility" actions={result.window && <span className="text-xs text-[var(--muted)]">Needs a driver {formatTime(result.window.start)}–{formatTime(result.window.end)} (travel {ds.settings.travel_to_pickup_minutes} min + trip + {ds.settings.post_trip_buffer_minutes} min buffer)</span>}>
          <p className="mb-3 text-sm text-[var(--muted)]">Suggestions only. Assign and contact drivers the usual way; the app never dispatches or messages anyone.</p>
          <MatchGroup title="Eligible" tone="green" items={result.eligible} onOverride={setOverrideFor} />
          <MatchGroup title="Tentative: confirm with the driver first" tone="amber" items={result.tentative} onOverride={setOverrideFor} />
          <MatchGroup title="Review required: information missing" tone="gray" items={result.review} onOverride={setOverrideFor} />
          <MatchGroup title="Overridden by dispatcher" tone="purple" items={result.overridden} onRevoke={(m) => void revoke(m.driverId)} />
          <div className="mt-3">
            <Button variant="ghost" onClick={() => setShowIneligible((v) => !v)} aria-expanded={showIneligible}>
              {showIneligible ? '▾' : '▸'} Not eligible ({result.ineligible.length})
            </Button>
            {showIneligible && <MatchGroup title="" tone="red" items={result.ineligible} onOverride={setOverrideFor} />}
          </div>
        </Card>
      )}

      <details className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <summary className="cursor-pointer text-sm font-medium">Original Google Calendar event (read-only)</summary>
        <p className="mt-2 text-sm font-medium">{r.raw_summary}</p>
        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-[var(--surface-2)] p-3 text-xs">{r.raw_description}</pre>
        <p className="mt-2 text-xs text-[var(--muted)]">Last synced {formatDayTime(Date.parse(r.last_synced_at))} · event {r.google_event_id}</p>
      </details>

      <OverrideDialog match={overrideFor} onClose={() => setOverrideFor(null)} onSave={async (reason) => {
        try { await setOverride(r.id, overrideFor!.driverId, reason); toast('success', 'Override recorded'); setOverrideFor(null); await refresh(); }
        catch (e) { toast('error', toAppError(e).message); }
      }} />
      <CorrectionDialog open={editOpen} r={r} ds={ds} onClose={() => setEditOpen(false)} onSaved={async () => { setEditOpen(false); await refresh(); }} />
    </div>
  );
}

function MatchGroup({ title, tone, items, onOverride, onRevoke }: {
  title: string; tone: 'green' | 'amber' | 'gray' | 'red' | 'purple'; items: DriverMatch[];
  onOverride?: (m: DriverMatch) => void; onRevoke?: (m: DriverMatch) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mb-3">
      {title && <h3 className="mb-1 text-sm font-semibold"><Badge tone={tone}>{items.length}</Badge> {title}</h3>}
      <ul className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
        {items.map((m) => (
          <li key={m.driverId} className="flex flex-wrap items-start gap-3 p-3">
            <div className="min-w-48 flex-1">
              <p className="font-medium">{m.name}</p>
              <p className="text-xs text-[var(--muted)]">
                {m.vehicle ? `${m.vehicle.name} · ${m.vehicle.maxPassengers} seats · ${m.vehicle.maxLuggage ?? '?'} bags` : 'No vehicle'}
                {m.minRateCents !== null && ` · minimum ${formatUSD(m.minRateCents)}`}
              </p>
              {m.coveringSegments.filter((s) => s.status === 'AVAILABLE' || s.status === 'TENTATIVE').length > 0 && (
                <p className="text-xs text-[var(--muted)]">Available {m.coveringSegments.filter((s) => s.status !== 'UNKNOWN').map((s) => `${formatTime(s.start)}–${formatTime(s.end)} ${s.status.toLowerCase()}`).join(', ')}</p>
              )}
              <ul className="mt-1 space-y-0.5 text-sm">
                {m.reasons.map((x, i) => (
                  <li key={i} className={x.severity === 'FAIL' ? 'text-red-700 dark:text-red-300' : x.severity === 'REVIEW' ? 'text-amber-800 dark:text-amber-300' : x.severity === 'TENTATIVE' ? 'text-amber-700' : 'text-[var(--muted)]'}>
                    {x.severity === 'FAIL' ? '✕' : x.severity === 'INFO' ? 'ℹ' : '!'} {x.message}
                  </li>
                ))}
              </ul>
              {m.override && <p className="mt-1 text-sm text-purple-700 dark:text-purple-300">Override: {m.override.reason} ({formatDayTime(m.override.createdAt)})</p>}
            </div>
            {onOverride && tone !== 'green' && <Button variant="outline" size="sm" onClick={() => onOverride(m)}>Override…</Button>}
            {onRevoke && <Button variant="ghost" size="sm" onClick={() => onRevoke(m)}>Remove override</Button>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function OverrideDialog({ match, onClose, onSave }: { match: DriverMatch | null; onClose: () => void; onSave: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={!!match} onClose={onClose} title={`Override for ${match?.name ?? ''}`}
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={reason.trim().length < 3} loading={busy} onClick={async () => { setBusy(true); await onSave(reason.trim()); setBusy(false); setReason(''); }}>Record override</Button></>}>
      <div className="space-y-3">
        <Notice>The driver will be listed as <strong>Overridden</strong>, never as a normal eligible match, and the original reasons stay visible. This is logged.</Notice>
        <Field label="Reason" htmlFor="ov-reason"><Textarea id="ov-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Called the driver; they can leave early" /></Field>
      </div>
    </Dialog>
  );
}

function CorrectionDialog({ open, r, ds, onClose, onSaved }: {
  open: boolean; r: ReservationEffectiveRow; ds: NonNullable<ReturnType<typeof useAdminDataset>['data']>; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const toast = useToast();
  const [f, setF] = useState(() => ({
    is_reservation: r.is_reservation ? 'yes' : 'no',
    destination_id: r.destination_source === 'CORRECTED' ? r.destination_id ?? '' : '',
    passenger_count: r.passengers_source === 'CORRECTED' ? String(r.passengers ?? '') : '',
    checked_bags: '',
    assignment: r.assignment_source === 'CORRECTED' ? (r.assignment === 'UNFILLED' ? 'clear' : r.assigned_driver_id ?? '') : '',
    payout: r.corrected_payout_cents != null ? String(r.corrected_payout_cents / 100) : '',
    congestion: r.congestion_source === 'CORRECTED' ? r.congestion : '',
    duration: r.corrected_duration_minutes != null ? String(r.corrected_duration_minutes) : '',
    notes: r.correction_notes ?? '',
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setError(null);
    const payout = f.payout.trim() ? parseDollars(f.payout) : null;
    if (f.payout.trim() && payout === null) { setError('Payout must be a dollar amount.'); return; }
    const fields = {
      is_reservation: f.is_reservation === 'yes',
      destination_id: f.destination_id || null,
      passenger_count: f.passenger_count === '' ? null : Number(f.passenger_count),
      checked_bags: f.checked_bags === '' ? null : Number(f.checked_bags),
      assigned_driver_id: f.assignment && f.assignment !== 'clear' ? f.assignment : null,
      clear_assignment: f.assignment === 'clear',
      proposed_payout_cents: payout,
      congestion: f.congestion || null,
      duration_minutes: f.duration === '' ? null : Number(f.duration),
      notes: f.notes.trim() || null,
    };
    setBusy(true);
    try {
      await saveReservationCorrection(r.id, fields, r.correction_version);
      toast('success', 'Correction saved (Google Calendar is unchanged)');
      await onSaved();
    } catch (e) { setError(toAppError(e).message); }
    finally { setBusy(false); }
  };
  const reset = async () => {
    setBusy(true);
    try { await clearReservationCorrection(r.id); toast('success', 'Corrections removed; imported values are used again'); await onSaved(); }
    catch (e) { setError(toAppError(e).message); }
    finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Correct reservation details" variant="sheet"
      footer={<>{r.correction_version !== null && <Button variant="ghost" className="mr-auto" onClick={() => void reset()} disabled={busy}>Remove all corrections</Button>}
        <Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={() => void save()} loading={busy}>Save</Button></>}>
      <div className="space-y-4">
        <Notice>Corrections are stored only in this app. The imported values are kept separately and Google Calendar is never changed. Leave a field blank to use the imported value.</Notice>
        <Field label="Is this a reservation?" htmlFor="c-isres"><Select id="c-isres" value={f.is_reservation} onChange={(e) => setF({ ...f, is_reservation: e.target.value })}><option value="yes">Yes</option><option value="no">No, ignore it</option></Select></Field>
        <Field label="Destination" htmlFor="c-dest" help={`Imported: ${r.destination_source === 'CORRECTED' ? 'overridden' : r.destination_code ?? 'unknown'}`}>
          <Select id="c-dest" value={f.destination_id} onChange={(e) => setF({ ...f, destination_id: e.target.value })}><option value="">Use imported</option>{ds.destinations.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Passengers" htmlFor="c-pax"><Input id="c-pax" type="number" min={0} max={60} value={f.passenger_count} onChange={(e) => setF({ ...f, passenger_count: e.target.value })} /></Field>
          <Field label="Checked bags" htmlFor="c-bags"><Input id="c-bags" type="number" min={0} max={100} value={f.checked_bags} onChange={(e) => setF({ ...f, checked_bags: e.target.value })} /></Field>
          <Field label="Driver payout ($)" htmlFor="c-pay" help="Base amount, without congestion"><Input id="c-pay" inputMode="decimal" value={f.payout} onChange={(e) => setF({ ...f, payout: e.target.value })} /></Field>
          <Field label="Trip duration (min)" htmlFor="c-dur"><Input id="c-dur" type="number" min={1} max={1440} value={f.duration} onChange={(e) => setF({ ...f, duration: e.target.value })} /></Field>
        </div>
        <Field label="Congestion pricing" htmlFor="c-cong"><Select id="c-cong" value={f.congestion} onChange={(e) => setF({ ...f, congestion: e.target.value })}>
          <option value="">Use imported ({r.congestion_source === 'CORRECTED' ? 'overridden' : r.congestion.toLowerCase()})</option><option value="YES">Applies</option><option value="NO">Does not apply</option><option value="UNKNOWN">Not determined yet</option>
        </Select></Field>
        <Field label="Assignment" htmlFor="c-assign" help="Only if Google Calendar is wrong or missing the driver.">
          <Select id="c-assign" value={f.assignment} onChange={(e) => setF({ ...f, assignment: e.target.value })}>
            <option value="">Use imported</option><option value="clear">Unfilled (no driver)</option>
            {ds.drivers.filter((d) => d.status === 'APPROVED').map((d) => <option key={d.user_id} value={d.user_id}>{d.full_name || d.email}</option>)}
          </Select>
        </Field>
        <Field label="Dispatcher notes" htmlFor="c-notes"><Textarea id="c-notes" value={f.notes} maxLength={2000} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Dialog>
  );
}
