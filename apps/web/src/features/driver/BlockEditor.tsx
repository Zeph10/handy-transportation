import { useEffect, useMemo, useState } from 'react';
import {
  addDays, applyToDates, formatLocalDate, instantToLocalDate, instantToLocalTime, localToInstant, startOfWeek, validateBlock, duplicateAfter,
} from '@handy/core';
import type { AvailabilityBlock, AvailabilityStatus, DestinationOffer, RuleOccurrence } from '@handy/core';
import { Button, Chip, Dialog, Field, Input, Notice, Select, Textarea, useConfirm, useToast, cx } from '@/components/ui';
import { adminDeleteBlock, adminSaveBlock, deleteBlock, saveBlock, saveBlocksBatch, skipOccurrence } from '@/lib/api';
import type { SaveResult } from '@/lib/api';
import { blockPayload } from '@/lib/convert';
import { toAppError } from '@/lib/errors';
import { STATUS_STYLE, WEEKDAY_NAMES } from '@/lib/style';
import { DestinationPicker } from './DestinationPicker';
import { useDriverReference, useInvalidateSchedule } from './hooks';

export type EditorTarget =
  | { kind: 'new'; start: number; end: number }
  | { kind: 'block'; block: AvailabilityBlock; version: number }
  | { kind: 'occurrence'; occurrence: RuleOccurrence };

export type EditorMode = { as: 'driver' } | { as: 'admin' };

export function BlockEditor({ driverId, target, mode, onClose, congestionCents }: {
  driverId: string;
  target: EditorTarget | null;
  mode: EditorMode;
  onClose: () => void;
  congestionCents?: number;
}) {
  const ref = useDriverReference(driverId);
  const invalidate = useInvalidateSchedule();
  const toast = useToast();
  const confirm = useConfirm();

  const [date, setDate] = useState('');
  const [startT, setStartT] = useState('');
  const [endT, setEndT] = useState('');
  const [status, setStatus] = useState<AvailabilityStatus>('AVAILABLE');
  const [vehicleId, setVehicleId] = useState<string | null>(null);
  const [dests, setDests] = useState<DestinationOffer[]>([]);
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);

  // Initialise the form whenever a new target opens.
  useEffect(() => {
    if (!target) return;
    setErrors({}); setReason(''); setCopyOpen(false);
    const defaultVehicle = ref.vehicles.find((v) => v.is_default)?.id ?? ref.vehicles[0]?.id ?? null;
    const defaultDests = ref.defaults.filter((d) => d.accepted).map((d) => ({ destinationId: d.destination_id, minRateCents: null }));
    const s = target.kind === 'new' ? target.start : target.kind === 'block' ? target.block.start : target.occurrence.start;
    const e = target.kind === 'new' ? target.end : target.kind === 'block' ? target.block.end : target.occurrence.end;
    setDate(instantToLocalDate(s));
    setStartT(instantToLocalTime(s));
    setEndT(instantToLocalTime(e));
    if (target.kind === 'new') {
      setStatus('AVAILABLE'); setVehicleId(defaultVehicle); setDests(defaultDests); setNotes('');
    } else {
      const src = target.kind === 'block' ? target.block : target.occurrence;
      setStatus(src.status);
      setVehicleId(src.vehicleId ?? defaultVehicle);
      setDests(src.destinations.length ? src.destinations : defaultDests);
      setNotes(target.kind === 'block' ? target.block.notes ?? '' : '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const startInstant = date && startT ? localToInstant(date, startT) : NaN;
  const overnight = !!(startT && endT && endT <= startT);
  const endInstant = date && endT ? localToInstant(overnight ? addDays(date, 1) : date, endT) : NaN;
  const isAdmin = mode.as === 'admin';
  const activeVehicles = ref.vehicles.filter((v) => v.is_active);

  const draft = useMemo(() => ({
    start: startInstant, end: endInstant, status, vehicleId, destinations: dests, notes: notes.trim() || null,
  }), [startInstant, endInstant, status, vehicleId, dests, notes]);

  const report = (r: SaveResult, what: string) => {
    if (r.result === 'PENDING_APPROVAL') {
      toast('info', `${what} sent to the dispatcher for approval (short notice). Your current availability stays until it is approved.`);
    } else {
      toast('success', `${what} saved`);
    }
  };

  const save = async () => {
    const errs = validateBlock(draft);
    if (isAdmin && !reason.trim()) errs.push({ field: 'reason', message: 'Add a short reason (it is recorded in the audit log and shown to the driver).' });
    setErrors(Object.fromEntries(errs.map((x) => [x.field.split('.')[0], x.message])));
    if (errs.length || !target) return;
    setBusy(true);
    try {
      const occ = target.kind === 'occurrence' ? target.occurrence : null;
      const payload = blockPayload({ ...draft, ruleId: occ?.ruleId, occurrenceDate: occ?.occurrenceDate });
      let r: SaveResult;
      if (target.kind === 'block') {
        r = isAdmin
          ? await adminSaveBlock(driverId, payload, reason.trim(), target.block.id, target.version)
          : await saveBlock(payload, target.block.id, target.version);
      } else {
        r = isAdmin ? await adminSaveBlock(driverId, payload, reason.trim()) : await saveBlock(payload);
      }
      report(r, 'Availability');
      await invalidate();
      onClose();
    } catch (e) {
      const err = toAppError(e);
      if (err.code === 'CONFLICT') { await invalidate(); }
      setErrors({ form: err.message });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!target) return;
    if (target.kind === 'occurrence') {
      const choice = await confirm({
        title: 'Remove this availability?',
        body: <p>This comes from your weekly schedule. Remove it for <strong>{formatLocalDate(target.occurrence.occurrenceDate)}</strong> only, or change the whole schedule on the Weekly schedule page.</p>,
        choices: [{ label: 'Remove this day only', value: 'one', danger: true }],
      });
      if (choice !== 'one') return;
      setBusy(true);
      try { report(await skipOccurrence(target.occurrence.ruleId, target.occurrence.occurrenceDate), 'Change'); await invalidate(); onClose(); }
      catch (e) { setErrors({ form: toAppError(e).message }); }
      finally { setBusy(false); }
      return;
    }
    if (target.kind !== 'block') return;
    if (isAdmin && !reason.trim()) { setErrors({ reason: 'Add a short reason before deleting.' }); return; }
    if (!(await confirm({ title: 'Delete this availability block?', body: 'This cannot be undone.', danger: true, confirmLabel: 'Delete' }))) return;
    setBusy(true);
    try {
      const r = isAdmin
        ? await adminDeleteBlock(target.block.id, target.version, reason.trim())
        : await deleteBlock(target.block.id, target.version);
      report(r, 'Deletion');
      await invalidate();
      onClose();
    } catch (e) { setErrors({ form: toAppError(e).message }); }
    finally { setBusy(false); }
  };

  const duplicate = async () => {
    if (target?.kind !== 'block') return;
    setBusy(true);
    try {
      const r = await saveBlocksBatch([blockPayload(duplicateAfter(target.block))], 'COPY');
      toast(r.inserted ? 'success' : 'info', r.inserted ? 'Duplicated right after this block' : 'No room right after this block');
      await invalidate();
      onClose();
    } catch (e) { setErrors({ form: toAppError(e).message }); }
    finally { setBusy(false); }
  };

  if (!target) return null;
  const title = target.kind === 'new' ? 'Add availability' : target.kind === 'occurrence' ? 'Edit this day (weekly schedule)' : 'Edit availability';

  return (
    <Dialog open={!!target} onClose={onClose} title={title} variant="sheet"
      footer={
        <>
          {target.kind !== 'new' && <Button variant="danger" className="mr-auto" onClick={() => void remove()} disabled={busy}>Delete</Button>}
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} loading={busy}>Save</Button>
        </>
      }>
      <div className="space-y-5">
        {target.kind === 'occurrence' && (
          <Notice>This day comes from your weekly schedule. Saving here changes <strong>this day only</strong>. To change every week, use Weekly schedule.</Notice>
        )}
        {target.kind === 'block' && !isAdmin && (
          <p className="text-xs text-[var(--muted)]">Changes that reduce availability within the short-notice window go to the dispatcher for approval.</p>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Date" htmlFor="b-date" required error={errors.start}>
            <Input id="b-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="From" htmlFor="b-start" required>
            <Input id="b-start" type="time" step={60} value={startT} onChange={(e) => setStartT(e.target.value)} />
          </Field>
          <Field label="Until" htmlFor="b-end" required error={errors.end}
            help={overnight ? `Ends next day (${formatLocalDate(addDays(date, 1))})` : undefined}>
            <Input id="b-end" type="time" step={60} value={endT} onChange={(e) => setEndT(e.target.value)} />
          </Field>
        </div>

        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">Status</legend>
          <div className="grid grid-cols-3 gap-2" role="radiogroup">
            {(['AVAILABLE', 'TENTATIVE', 'UNAVAILABLE'] as const).map((s) => (
              <button key={s} type="button" role="radio" aria-checked={status === s} onClick={() => setStatus(s)}
                className={cx('min-h-11 rounded-lg border text-sm font-medium', status === s ? 'border-transparent text-white' : 'border-[var(--border)]')}
                style={status === s ? { background: STATUS_STYLE[s].bg } : undefined}>
                {STATUS_STYLE[s].label}
              </button>
            ))}
          </div>
        </fieldset>

        {status !== 'UNAVAILABLE' && (
          <>
            <Field label="Vehicle for this time" htmlFor="b-vehicle" required error={errors.vehicleId}
              help={activeVehicles.length === 0 ? 'Add a vehicle on the Vehicles page first.' : undefined}>
              <Select id="b-vehicle" value={vehicleId ?? ''} onChange={(e) => setVehicleId(e.target.value || null)}>
                <option value="">Choose…</option>
                {activeVehicles.map((v) => (
                  <option key={v.id} value={v.id}>{v.name} · {v.max_passengers} seats{v.max_luggage != null ? ` · ${v.max_luggage} bags` : ''}</option>
                ))}
              </Select>
            </Field>
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Destinations you'll take</p>
              <DestinationPicker destinations={ref.destinations} defaults={ref.defaults} value={dests} onChange={setDests} congestionCents={congestionCents} />
              {errors.destinations && <p className="text-xs font-medium text-red-600" role="alert">{errors.destinations}</p>}
              {errors.rate && <p className="text-xs font-medium text-red-600" role="alert">{errors.rate}</p>}
            </div>
          </>
        )}

        <Field label="Notes (optional)" htmlFor="b-notes">
          <Textarea id="b-notes" value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        {isAdmin && (
          <Field label="Reason for this change" htmlFor="b-reason" required error={errors.reason} help="Recorded in the audit log and shown to the driver.">
            <Input id="b-reason" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
          </Field>
        )}

        {target.kind === 'block' && !isAdmin && (
          <div className="flex flex-wrap gap-2 border-t border-[var(--border)] pt-4">
            <Button variant="outline" size="sm" onClick={() => void duplicate()} disabled={busy}>Duplicate after</Button>
            <Button variant="outline" size="sm" onClick={() => setCopyOpen((v) => !v)} aria-expanded={copyOpen}>Copy to other days…</Button>
          </div>
        )}
        {copyOpen && target.kind === 'block' && (
          <CopyToDays block={target.block} onDone={async () => { await invalidate(); onClose(); }} />
        )}

        {errors.form && <Notice tone="error">{errors.form}</Notice>}
      </div>
    </Dialog>
  );
}

function CopyToDays({ block, onDone }: { block: AvailabilityBlock; onDone: () => Promise<void> }) {
  const toast = useToast();
  const sourceDate = instantToLocalDate(block.start);
  const [weekStart, setWeekStart] = useState(startOfWeek(sourceDate));
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const toggle = (d: string) => setPicked((p) => (p.includes(d) ? p.filter((x) => x !== d) : [...p, d]));
  const go = async () => {
    setBusy(true);
    try {
      const r = await saveBlocksBatch(applyToDates(block, picked).map((b) => blockPayload(b)), 'COPY');
      toast('success', `Copied to ${r.inserted} day${r.inserted === 1 ? '' : 's'}${r.skipped ? ` (${r.skipped} skipped: already had availability then)` : ''}`);
      await onDone();
    } catch (e) { toast('error', toAppError(e).message); }
    finally { setBusy(false); }
  };
  return (
    <div className="space-y-3 rounded-lg border border-[var(--border)] p-3">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => setWeekStart(addDays(weekStart, -7))} aria-label="Previous week">‹</Button>
        <span className="text-sm font-medium">Week of {formatLocalDate(weekStart)}</span>
        <Button variant="ghost" size="sm" onClick={() => setWeekStart(addDays(weekStart, 7))} aria-label="Next week">›</Button>
      </div>
      <div className="flex flex-wrap gap-2">
        {days.map((d, i) => (
          <Chip key={d} selected={picked.includes(d)} onClick={() => toggle(d)} disabled={d === sourceDate}>
            {WEEKDAY_NAMES[i]} {Number(d.slice(8))}
          </Chip>
        ))}
      </div>
      <Button size="sm" onClick={() => void go()} disabled={picked.length === 0} loading={busy}>Copy to {picked.length || ''} day{picked.length === 1 ? '' : 's'}</Button>
    </div>
  );
}
