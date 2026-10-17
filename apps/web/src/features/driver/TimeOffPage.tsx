import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatLocalDate, todayLocal, validateTimeOff } from '@handy/core';
import { Button, Card, EmptyState, ErrorNotice, Field, Input, Loading, Notice, PageHeader, useConfirm, useToast } from '@/components/ui';
import { deleteTimeOff, listTimeOff, saveTimeOff } from '@/lib/api';
import { toAppError } from '@/lib/errors';
import { useUserId } from '@/features/auth/session';
import { useInvalidateSchedule } from './hooks';

export function TimeOffPage() {
  const driverId = useUserId();
  const qc = useQueryClient();
  const invalidate = useInvalidateSchedule();
  const toast = useToast();
  const confirm = useConfirm();
  const list = useQuery({ queryKey: ['time-off', driverId], queryFn: () => listTimeOff(driverId) });
  const [start, setStart] = useState(todayLocal());
  const [end, setEnd] = useState(todayLocal());
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const refresh = async () => { await qc.invalidateQueries({ queryKey: ['time-off', driverId] }); await invalidate(); };

  const add = async () => {
    const errs = validateTimeOff({ startDate: start, endDate: end });
    setErrors(Object.fromEntries(errs.map((e) => [e.field, e.message])));
    if (errs.length) return;
    setBusy(true);
    try {
      const r = await saveTimeOff(start, end, note.trim() || null);
      toast(r.result === 'SAVED' ? 'success' : 'info', r.result === 'SAVED' ? 'Time off saved' : 'Time off is short notice, so it was sent to the dispatcher for approval');
      setNote('');
      await refresh();
    } catch (e) { setErrors({ form: toAppError(e).message }); }
    finally { setBusy(false); }
  };

  const remove = async (id: string, version: number) => {
    if (!(await confirm({ title: 'Remove this time off?', body: 'Your normal weekly schedule will apply again on these days.', confirmLabel: 'Remove', danger: true }))) return;
    try { await deleteTimeOff(id, version); toast('success', 'Time off removed'); await refresh(); }
    catch (e) { toast('error', toAppError(e).message); }
  };

  const today = todayLocal();
  const upcoming = (list.data ?? []).filter((t) => t.end_date >= today);

  return (
    <div>
      <PageHeader title="Time off" subtitle="Vacation or days off. Time off overrides your weekly schedule for those days." />
      <Card title="Add time off">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="First day off" htmlFor="to-start" error={errors.startDate}><Input id="to-start" type="date" value={start} onChange={(e) => { setStart(e.target.value); if (e.target.value > end) setEnd(e.target.value); }} /></Field>
          <Field label="Last day off" htmlFor="to-end" error={errors.endDate}><Input id="to-end" type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} /></Field>
          <Field label="Note (optional)" htmlFor="to-note"><Input id="to-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></Field>
        </div>
        {errors.form && <div className="mt-3"><Notice tone="error">{errors.form}</Notice></div>}
        <Button className="mt-4" onClick={() => void add()} loading={busy}>Save time off</Button>
      </Card>
      <h2 className="mb-2 mt-6 font-semibold">Upcoming</h2>
      {list.isLoading ? <Loading /> : list.error ? <ErrorNotice error={list.error} /> : upcoming.length === 0 ? (
        <EmptyState title="No upcoming time off" />
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          {upcoming.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div>
                <p className="font-medium">{formatLocalDate(t.start_date)}{t.end_date !== t.start_date && ` – ${formatLocalDate(t.end_date)}`}</p>
                {t.note && <p className="text-sm text-[var(--muted)]">{t.note}</p>}
              </div>
              <Button variant="ghost" size="sm" onClick={() => void remove(t.id, t.version)}>Remove</Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
