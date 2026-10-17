import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  addDays, blocksToTemplate, copyDay, copyWeek, formatLocalDate, localToInstant, startOfWeek, templateToBlocks, todayLocal,
} from '@handy/core';
import type { TemplateBlock } from '@handy/core';
import { Button, Card, Dialog, ErrorNotice, Field, Input, Notice, PageHeader, Select, useConfirm, useToast } from '@/components/ui';
import { clearRange, getPublicSettings, listMyChangeRequests, myAdminChanges, saveBlocksBatch, saveTemplate, deleteTemplate } from '@/lib/api';
import { blockPayload } from '@/lib/convert';
import { toAppError } from '@/lib/errors';
import { WEEKDAY_LONG } from '@/lib/style';
import { useSession, useUserId } from '@/features/auth/session';
import { CalendarToolbar, CalendarView, useCalendarNav } from '@/features/calendar/CalendarView';
import { Legend } from '@/features/calendar/Legend';
import { BlockEditor } from './BlockEditor';
import type { EditorTarget } from './BlockEditor';
import { driverEvents } from './availabilityEvents';
import { useDriverReference, useInvalidateSchedule, useSchedule, useTemplates } from './hooks';

export function DriverAvailabilityPage() {
  const driverId = useUserId();
  const { profile } = useSession();
  const nav = useCalendarNav();
  const ref = useDriverReference(driverId);
  // Load the whole visible week plus the previous week (for "copy previous week" / "copy yesterday").
  const weekStart = startOfWeek(nav.date);
  const sched = useSchedule(driverId, addDays(weekStart, -7), addDays(weekStart, 6));
  const settings = useQuery({ queryKey: ['public-settings'], queryFn: getPublicSettings });
  const requests = useQuery({ queryKey: ['my-requests', driverId], queryFn: () => listMyChangeRequests(driverId) });
  const adminChanges = useQuery({ queryKey: ['my-admin-changes'], queryFn: myAdminChanges });
  const [target, setTarget] = useState<EditorTarget | null>(null);

  const pending = useMemo(() => (requests.data ?? []).filter((r) => r.status === 'PENDING'), [requests.data]);
  const pendingTargets = useMemo(() => new Set(pending.map((r) => r.target_id).filter((x): x is string => !!x)), [pending]);
  const adminBlockIds = useMemo(() => new Set((sched.data?.rows.blocks ?? []).filter((b) => b.origin === 'ADMIN').map((b) => b.id)), [sched.data]);

  const events = useMemo(() => {
    if (!sched.data) return [];
    return driverEvents(sched.data.schedule, nav.from, nav.to, { vehicles: ref.vehicles, destinations: ref.destinations, pendingTargets, adminBlockIds });
  }, [sched.data, nav.from, nav.to, ref.vehicles, ref.destinations, pendingTargets, adminBlockIds]);

  const openEvent = (_id: string, p: Record<string, unknown>) => {
    if (!sched.data) return;
    if (p.kind === 'block') {
      const b = sched.data.schedule.blocks.find((x) => x.id === p.blockId);
      const row = sched.data.rows.blocks.find((x) => x.id === p.blockId);
      if (b && row) setTarget({ kind: 'block', block: b, version: row.version });
    } else if (p.kind === 'occurrence') {
      const s = sched.data.schedule;
      const rule = s.rules.find((r) => r.id === p.ruleId);
      if (!rule) return;
      const occ = {
        ruleId: rule.id, occurrenceDate: String(p.occurrenceDate), status: rule.status, vehicleId: rule.vehicleId, destinations: rule.destinations,
        start: localToInstant(String(p.occurrenceDate), rule.localStart),
        end: localToInstant(addDays(String(p.occurrenceDate), rule.endDayOffset), rule.localEnd),
      };
      setTarget({ kind: 'occurrence', occurrence: occ });
    }
  };

  const addNew = () => {
    const day = nav.view === 'day' ? nav.date : todayLocal() >= nav.from && todayLocal() <= nav.to ? todayLocal() : nav.from;
    setTarget({ kind: 'new', start: localToInstant(day, '08:00'), end: localToInstant(day, '16:00') });
  };

  const noVehicle = !ref.loading && ref.vehicles.length === 0;
  const recentAdmin = (adminChanges.data ?? []).filter((c) => Date.now() - Date.parse(c.created_at) < 14 * 86_400_000);
  const deadline = settings.data ? `${WEEKDAY_LONG[settings.data.submission_deadline_dow - 1]} ${settings.data.submission_deadline_time}` : null;

  return (
    <div>
      <PageHeader
        title={`Hi${profile?.full_name ? `, ${profile.full_name.split(' ')[0]}` : ''}`}
        subtitle={<>Share when you can drive. It's optional and you can change it any time.{deadline && <> Helpful by {deadline} for the following week.</>}</>}
        actions={<Button size="lg" onClick={addNew} disabled={noVehicle}>+ Add availability</Button>}
      />

      {noVehicle && (
        <Notice tone="warn">Start by adding your vehicle: <Link to="/driver/vehicles" className="font-semibold underline">Vehicles</Link>. Then check your <Link to="/driver/rates" className="font-semibold underline">destinations & rates</Link>.</Notice>
      )}
      {pending.length > 0 && (
        <div className="mt-3"><Notice tone="warn">{pending.length} change{pending.length > 1 ? 's are' : ' is'} waiting for dispatcher approval (dashed outline). Your current availability stays until approved. <Link to="/driver/changes" className="font-semibold underline">Details</Link></Notice></div>
      )}
      {recentAdmin.length > 0 && (
        <div className="mt-3"><Notice>The dispatcher changed your availability recently (purple edge). <Link to="/driver/changes" className="font-semibold underline">See what changed</Link></Notice></div>
      )}

      <div className="mt-4">
        <CalendarToolbar nav={nav} />
        <Shortcuts driverId={driverId} nav={nav} schedule={sched.data?.schedule ?? null} />
        {sched.error ? <ErrorNotice error={sched.error} onRetry={() => void sched.refetch()} /> : (
          <div className="relative">
            {sched.isFetching && <span className="absolute right-3 top-3 z-10 text-xs text-[var(--muted)]" role="status">Updating…</span>}
            <CalendarView nav={nav} events={events} onSelect={(s, e) => setTarget({ kind: 'new', start: s, end: e })} onEventClick={openEvent} selectable={!noVehicle} />
          </div>
        )}
        <div className="mt-3"><Legend /></div>
        {!sched.isLoading && events.filter((e) => !e.display).length === 0 && (
          <p className="mt-3 text-sm text-[var(--muted)]">Nothing shared for these days yet, so the dispatcher sees you as <strong>unknown</strong>. Tap <strong>+ Add availability</strong>, or drag across the calendar. To repeat every week, use <Link to="/driver/schedule" className="underline">Weekly schedule</Link>.</p>
        )}
      </div>

      <BlockEditor driverId={driverId} target={target} mode={{ as: 'driver' }} onClose={() => setTarget(null)} congestionCents={settings.data?.congestion_surcharge_cents} />
    </div>
  );
}

function Shortcuts({ driverId, nav, schedule }: {
  driverId: string;
  nav: ReturnType<typeof useCalendarNav>;
  schedule: import('@/lib/convert').DriverSchedule | null;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const invalidate = useInvalidateSchedule();
  const templates = useTemplates(driverId);
  const [busy, setBusy] = useState<string | null>(null);
  const [tplOpen, setTplOpen] = useState(false);
  const weekStart = startOfWeek(nav.date);
  const day = nav.view === 'day' ? nav.date : todayLocal() >= nav.from && todayLocal() <= nav.to ? todayLocal() : nav.from;

  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    try { toast('success', await fn()); await invalidate(); }
    catch (e) { toast('error', toAppError(e).message); }
    finally { setBusy(null); }
  };
  const batchMsg = (r: { inserted: number; skipped: number; pending: number }, what: string) =>
    r.inserted === 0 && r.skipped === 0 && r.pending === 0 ? `Nothing to copy from ${what}` :
      `Copied ${r.inserted} block${r.inserted === 1 ? '' : 's'}${r.skipped ? `, ${r.skipped} skipped (already had availability)` : ''}${r.pending ? `, ${r.pending} sent for approval` : ''}`;

  const copyYesterday = () => run('yday', async () => {
    const blocks = copyDay(schedule?.blocks ?? [], addDays(day, -1), day);
    if (!blocks.length) return `No one-off availability on ${formatLocalDate(addDays(day, -1))} to copy`;
    return batchMsg(await saveBlocksBatch(blocks.map((b) => blockPayload(b)), 'COPY'), 'yesterday');
  });
  const copyPrevWeek = () => run('week', async () => {
    const blocks = copyWeek(schedule?.blocks ?? [], addDays(weekStart, -7), weekStart);
    if (!blocks.length) return 'No one-off availability last week to copy (weekly schedules repeat automatically)';
    return batchMsg(await saveBlocksBatch(blocks.map((b) => blockPayload(b)), 'COPY'), 'last week');
  });
  const clear = async (span: 'day' | 'week') => {
    const from = span === 'day' ? day : weekStart;
    const to = span === 'day' ? day : addDays(weekStart, 6);
    const choice = await confirm({
      title: span === 'day' ? `Clear ${formatLocalDate(day)}?` : `Clear the week of ${formatLocalDate(weekStart)}?`,
      body: <p>One-off availability will be removed. Weekly-schedule days can be removed for these dates only; your weekly schedule itself is not changed. Changes inside the short-notice window go to the dispatcher for approval.</p>,
      choices: [
        { label: 'Clear one-off blocks only', value: 'blocks', danger: true },
        { label: 'Also skip weekly-schedule days', value: 'all', danger: true },
      ],
    });
    if (!choice) return;
    await run('clear', async () => {
      const r = await clearRange(from, to, choice === 'all');
      return `Removed ${r.deleted} block${r.deleted === 1 ? '' : 's'}${r.skipped_occurrences ? ` and ${r.skipped_occurrences} weekly day${r.skipped_occurrences === 1 ? '' : 's'}` : ''}${r.pending ? `; ${r.pending} sent for approval` : ''}`;
    });
  };

  return (
    <>
      <div className="mb-3 flex flex-wrap gap-2" aria-label="Shortcuts">
        <Button variant="outline" size="sm" loading={busy === 'yday'} onClick={() => void copyYesterday()}>Copy yesterday → {formatLocalDate(day)}</Button>
        <Button variant="outline" size="sm" loading={busy === 'week'} onClick={() => void copyPrevWeek()}>Copy last week → this week</Button>
        <Button variant="outline" size="sm" onClick={() => setTplOpen(true)}>Templates…</Button>
        <Button variant="ghost" size="sm" loading={busy === 'clear'} onClick={() => void clear(nav.view === 'day' ? 'day' : 'week')}>
          Clear {nav.view === 'day' ? 'day' : 'week'}…
        </Button>
      </div>
      <TemplatesDialog open={tplOpen} onClose={() => setTplOpen(false)} driverId={driverId} weekStart={weekStart}
        schedule={schedule} templates={templates.data ?? []} onApplied={invalidate} />
    </>
  );
}

function TemplatesDialog({ open, onClose, driverId, weekStart, schedule, templates, onApplied }: {
  open: boolean; onClose: () => void; driverId: string; weekStart: string;
  schedule: import('@/lib/convert').DriverSchedule | null;
  templates: { id: string; name: string; span: 'DAY' | 'WEEK'; blocks: unknown[] }[];
  onApplied: () => Promise<unknown>;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  void driverId;
  const weekBlocks = (schedule?.blocks ?? []).filter((b) => b.start >= localToInstant(weekStart, '00:00') && b.start < localToInstant(addDays(weekStart, 7), '00:00'));

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await saveTemplate(name.trim(), 'WEEK', blocksToTemplate(weekBlocks, weekStart));
      toast('success', `Template "${name.trim()}" saved`);
      setName('');
      await onApplied();
    } catch (e) { toast('error', toAppError(e).message); }
    finally { setBusy(false); }
  };
  const apply = async () => {
    const t = templates.find((x) => x.id === selected);
    if (!t) return;
    setBusy(true);
    try {
      const r = await saveBlocksBatch(templateToBlocks(t.blocks as TemplateBlock[], weekStart).map((b) => blockPayload(b)), 'TEMPLATE');
      toast('success', `Applied "${t.name}": ${r.inserted} added${r.skipped ? `, ${r.skipped} skipped (already had availability)` : ''}${r.pending ? `, ${r.pending} sent for approval` : ''}`);
      await onApplied();
      onClose();
    } catch (e) { toast('error', toAppError(e).message); }
    finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    try { await deleteTemplate(id); toast('success', 'Template deleted'); await onApplied(); }
    catch (e) { toast('error', toAppError(e).message); }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Week templates">
      <div className="space-y-6">
        <Card title="Apply a template to this week">
          {templates.length === 0 ? <p className="text-sm text-[var(--muted)]">No templates yet. Save one below.</p> : (
            <div className="space-y-3">
              <Field label="Template" htmlFor="tpl-pick">
                <Select id="tpl-pick" value={selected} onChange={(e) => setSelected(e.target.value)}>
                  <option value="">Choose…</option>
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.blocks.length} blocks)</option>)}
                </Select>
              </Field>
              <div className="flex gap-2">
                <Button onClick={() => void apply()} disabled={!selected} loading={busy}>Apply to week of {formatLocalDate(weekStart)}</Button>
                {selected && <Button variant="ghost" onClick={() => void remove(selected)}>Delete template</Button>}
              </div>
            </div>
          )}
        </Card>
        <Card title="Save this week as a template">
          {weekBlocks.length === 0 ? <p className="text-sm text-[var(--muted)]">Add one-off availability this week first.</p> : (
            <div className="space-y-3">
              <p className="text-sm text-[var(--muted)]">Saves the {weekBlocks.length} one-off block{weekBlocks.length === 1 ? '' : 's'} in this week (times, vehicle, destinations and rates).</p>
              <Field label="Template name" htmlFor="tpl-name"><Input id="tpl-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. School-run weeks" /></Field>
              <Button onClick={() => void save()} disabled={!name.trim()} loading={busy}>Save template</Button>
            </div>
          )}
        </Card>
      </div>
    </Dialog>
  );
}
