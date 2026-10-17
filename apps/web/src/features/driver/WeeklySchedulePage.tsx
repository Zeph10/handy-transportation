import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatLocalDate, todayLocal, validateRule } from '@handy/core';
import type { AvailabilityStatus, DestinationOffer } from '@handy/core';
import { Badge, Button, Card, Chip, Dialog, EmptyState, ErrorNotice, Field, Input, Loading, Notice, PageHeader, Select, Textarea, useConfirm, useToast, cx } from '@/components/ui';
import { endRule, getPublicSettings, listRules, saveRule } from '@/lib/api';
import { ruleFromRow, rulePayload } from '@/lib/convert';
import { toAppError } from '@/lib/errors';
import { STATUS_STYLE, WEEKDAY_NAMES } from '@/lib/style';
import type { RuleRow } from '@/lib/types';
import { useUserId } from '@/features/auth/session';
import { DestinationPicker } from './DestinationPicker';
import { useDriverReference, useInvalidateSchedule } from './hooks';

const fmt12 = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

export function WeeklySchedulePage() {
  const driverId = useUserId();
  const ref = useDriverReference(driverId);
  const qc = useQueryClient();
  const rules = useQuery({ queryKey: ['rules', driverId], queryFn: () => listRules(driverId) });
  const settings = useQuery({ queryKey: ['public-settings'], queryFn: getPublicSettings });
  const [editing, setEditing] = useState<RuleRow | 'new' | null>(null);
  const toast = useToast();
  const confirm = useConfirm();
  const invalidate = useInvalidateSchedule();
  const today = todayLocal();
  const current = (rules.data ?? []).filter((r) => !r.effective_until || r.effective_until >= today);

  const end = async (r: RuleRow) => {
    const ok = await confirm({
      title: 'Stop this weekly schedule?',
      body: 'Future weeks will no longer repeat it. Days inside the short-notice window and the past are kept as they are.',
      confirmLabel: 'Stop repeating', danger: true,
    });
    if (!ok) return;
    try {
      const res = await endRule(r.id, r.version);
      toast('success', res.kept_until ? `Stopped. It still applies through ${formatLocalDate(res.kept_until)}.` : 'Weekly schedule removed');
      await qc.invalidateQueries({ queryKey: ['rules', driverId] });
      await invalidate();
    } catch (e) { toast('error', toAppError(e).message); }
  };

  return (
    <div>
      <PageHeader title="Weekly schedule" subtitle="Set times that repeat every week. You can still change single days on My availability."
        actions={<Button onClick={() => setEditing('new')} disabled={ref.vehicles.length === 0}>+ Add weekly time</Button>} />
      {rules.isLoading ? <Loading /> : rules.error ? <ErrorNotice error={rules.error} onRetry={() => void rules.refetch()} /> : current.length === 0 ? (
        <EmptyState title="No weekly schedule yet">Add the times you usually drive, for example weekdays 6 AM–2 PM.</EmptyState>
      ) : (
        <ul className="space-y-3">
          {current.map((r) => {
            const rule = ruleFromRow(r);
            const vehicle = ref.vehicles.find((v) => v.id === r.vehicle_id);
            return (
              <li key={r.id}>
                <Card>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <p className="font-semibold">{r.weekdays.slice().sort().map((d) => WEEKDAY_NAMES[d - 1]).join(', ')} · {fmt12(rule.localStart)} – {fmt12(rule.localEnd)}{r.end_day_offset ? ' (next day)' : ''}</p>
                      <p className="text-sm">
                        <Badge tone={r.status === 'AVAILABLE' ? 'green' : r.status === 'TENTATIVE' ? 'amber' : 'gray'}>{STATUS_STYLE[r.status].label}</Badge>
                        {vehicle && <span className="ml-2">{vehicle.name}</span>}
                        {r.status !== 'UNAVAILABLE' && <span className="ml-2 text-[var(--muted)]">{rule.destinations.map((d) => ref.destinations.find((x) => x.id === d.destinationId)?.code).join(', ')}</span>}
                      </p>
                      <p className="text-xs text-[var(--muted)]">From {formatLocalDate(r.effective_from)}{r.effective_until ? ` until ${formatLocalDate(r.effective_until)}` : ', no end date'}</p>
                    </div>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => setEditing(r)}>Edit</Button>
                      <Button variant="ghost" size="sm" onClick={() => void end(r)}>Stop</Button>
                    </div>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      <RuleEditor driverId={driverId} rule={editing} onClose={() => setEditing(null)} windowHours={settings.data?.short_notice_window_hours ?? 0}
        congestionCents={settings.data?.congestion_surcharge_cents}
        onSaved={async () => { await qc.invalidateQueries({ queryKey: ['rules', driverId] }); await invalidate(); }} />
    </div>
  );
}

function RuleEditor({ driverId, rule, onClose, onSaved, windowHours, congestionCents }: {
  driverId: string; rule: RuleRow | 'new' | null; onClose: () => void; onSaved: () => Promise<void>; windowHours: number; congestionCents?: number;
}) {
  const ref = useDriverReference(driverId);
  const toast = useToast();
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [start, setStart] = useState('06:00');
  const [end, setEnd] = useState('14:00');
  const [from, setFrom] = useState(todayLocal());
  const [until, setUntil] = useState('');
  const [status, setStatus] = useState<AvailabilityStatus>('AVAILABLE');
  const [vehicleId, setVehicleId] = useState<string | null>(null);
  const [dests, setDests] = useState<DestinationOffer[]>([]);
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!rule) return;
    setErrors({});
    if (rule === 'new') {
      setWeekdays([1, 2, 3, 4, 5]); setStart('06:00'); setEnd('14:00'); setFrom(todayLocal()); setUntil(''); setStatus('AVAILABLE');
      setVehicleId(ref.vehicles.find((v) => v.is_default)?.id ?? ref.vehicles[0]?.id ?? null);
      setDests(ref.defaults.filter((d) => d.accepted).map((d) => ({ destinationId: d.destination_id, minRateCents: null })));
      setNotes('');
    } else {
      const r = ruleFromRow(rule);
      setWeekdays(r.weekdays); setStart(r.localStart); setEnd(r.localEnd); setFrom(r.effectiveFrom); setUntil(r.effectiveUntil ?? '');
      setStatus(r.status); setVehicleId(r.vehicleId); setDests(r.destinations); setNotes(r.notes ?? '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rule]);

  const overnight = end <= start;
  const save = async () => {
    const draft = {
      weekdays, localStart: start, localEnd: end, endDayOffset: (overnight ? 1 : 0) as 0 | 1, effectiveFrom: from,
      effectiveUntil: until || null, status, vehicleId, destinations: dests, notes: notes.trim() || null,
    };
    const errs = validateRule(draft);
    if (status !== 'UNAVAILABLE' && !vehicleId) errs.push({ field: 'vehicleId', message: 'Choose a vehicle.' });
    if (status !== 'UNAVAILABLE' && dests.length === 0) errs.push({ field: 'destinations', message: 'Pick at least one destination.' });
    setErrors(Object.fromEntries(errs.map((e) => [e.field, e.message])));
    if (errs.length || !rule) return;
    setBusy(true);
    try {
      const res = await saveRule(rulePayload(draft), rule === 'new' ? undefined : rule.id, rule === 'new' ? undefined : rule.version);
      toast('success', res.kept_until
        ? `Saved. The new times start ${formatLocalDate(res.effective_from)}; earlier days keep your previous schedule.`
        : 'Weekly schedule saved');
      await onSaved();
      onClose();
    } catch (e) { setErrors({ form: toAppError(e).message }); }
    finally { setBusy(false); }
  };

  return (
    <Dialog open={!!rule} onClose={onClose} title={rule === 'new' ? 'Add weekly time' : 'Edit weekly time'} variant="sheet"
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={() => void save()} loading={busy}>Save</Button></>}>
      <div className="space-y-5">
        {rule !== 'new' && rule && windowHours > 0 && (
          <Notice>Changes apply from the first day after the {windowHours}-hour short-notice window. Past days and the next {windowHours} hours keep your current schedule.</Notice>
        )}
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">Days</legend>
          <div className="flex flex-wrap gap-2">
            {WEEKDAY_NAMES.map((n, i) => (
              <Chip key={n} selected={weekdays.includes(i + 1)} onClick={() => setWeekdays((w) => (w.includes(i + 1) ? w.filter((x) => x !== i + 1) : [...w, i + 1]))}>{n}</Chip>
            ))}
          </div>
          {errors.weekdays && <p className="mt-1 text-xs font-medium text-red-600">{errors.weekdays}</p>}
        </fieldset>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From" htmlFor="r-start" error={errors.localStart}><Input id="r-start" type="time" step={60} value={start} onChange={(e) => setStart(e.target.value)} /></Field>
          <Field label="Until" htmlFor="r-end" error={errors.localEnd} help={overnight ? 'Ends the next day (overnight)' : undefined}>
            <Input id="r-end" type="time" step={60} value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
          <Field label="Starting" htmlFor="r-from" error={errors.effectiveFrom}><Input id="r-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="Ending (optional)" htmlFor="r-until" error={errors.effectiveUntil}><Input id="r-until" type="date" value={until} onChange={(e) => setUntil(e.target.value)} /></Field>
        </div>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">Status</legend>
          <div className="grid grid-cols-3 gap-2" role="radiogroup">
            {(['AVAILABLE', 'TENTATIVE', 'UNAVAILABLE'] as const).map((s) => (
              <button key={s} type="button" role="radio" aria-checked={status === s} onClick={() => setStatus(s)}
                className={cx('min-h-11 rounded-lg border text-sm font-medium', status === s ? 'border-transparent text-white' : 'border-[var(--border)]')}
                style={status === s ? { background: STATUS_STYLE[s].bg } : undefined}>{STATUS_STYLE[s].label}</button>
            ))}
          </div>
        </fieldset>
        {status !== 'UNAVAILABLE' && (
          <>
            <Field label="Vehicle" htmlFor="r-vehicle" error={errors.vehicleId}>
              <Select id="r-vehicle" value={vehicleId ?? ''} onChange={(e) => setVehicleId(e.target.value || null)}>
                <option value="">Choose…</option>
                {ref.vehicles.filter((v) => v.is_active).map((v) => <option key={v.id} value={v.id}>{v.name} · {v.max_passengers} seats</option>)}
              </Select>
            </Field>
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Destinations</p>
              <DestinationPicker destinations={ref.destinations} defaults={ref.defaults} value={dests} onChange={setDests} congestionCents={congestionCents} />
              {errors.destinations && <p className="text-xs font-medium text-red-600">{errors.destinations}</p>}
            </div>
          </>
        )}
        <Field label="Notes (optional)" htmlFor="r-notes"><Textarea id="r-notes" value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} /></Field>
        {errors.form && <Notice tone="error">{errors.form}</Notice>}
      </div>
    </Dialog>
  );
}
