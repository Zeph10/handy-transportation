import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatUSD, parseDollars, validatePattern } from '@handy/core';
import { Badge, Button, Card, Checkbox, Dialog, ErrorNotice, Field, Input, Loading, Notice, PageHeader, Select, useConfirm, useToast } from '@/components/ui';
import {
  addAlias, deleteAlias, deleteParsingRule, deleteRateMapping, getSettings, listAliases, listDestinations, listDrivers, listNotificationCategories,
  listParsingConfig, saveDestination, sendRemindersNow, updateSettings, upsertParsingRule, upsertRateMapping,
} from '@/lib/api';
import { supabase } from '@/lib/supabase';
import { toAppError } from '@/lib/errors';
import { WEEKDAY_LONG } from '@/lib/style';
import type { AppSettingsRow, DestinationRow } from '@/lib/types';

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Settings" subtitle="Every change here is recorded in the audit log." />
      <GeneralSettings />
      <Destinations />
      <ParsingSettings />
      <Aliases />
      <Notifications />
    </div>
  );
}

function GeneralSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['settings'], queryFn: getSettings });
  const [f, setF] = useState<AppSettingsRow | null>(null);
  const [congestion, setCongestion] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (q.data) { setF(q.data); setCongestion(String(q.data.congestion_surcharge_cents / 100)); } }, [q.data]);
  if (q.isLoading || !f) return <Loading />;
  if (q.error) return <ErrorNotice error={q.error} />;
  const num = (k: keyof AppSettingsRow) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: Number(e.target.value) });

  const save = async () => {
    const c = parseDollars(congestion);
    if (c === null) { toast('error', 'Congestion surcharge must be a dollar amount.'); return; }
    setBusy(true);
    try {
      const { id: _id, version, environment: _env, ...rest } = f;
      void _id; void _env;
      await updateSettings({ ...rest, congestion_surcharge_cents: c }, version);
      toast('success', 'Settings saved');
      await qc.invalidateQueries({ queryKey: ['settings'] });
      await qc.invalidateQueries({ queryKey: ['admin-dataset'] });
    } catch (e) { toast('error', toAppError(e).message); }
    finally { setBusy(false); }
  };

  return (
    <Card title="Scheduling and matching">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Travel-to-pickup allowance (min)" htmlFor="s-travel" help="Time a driver needs to reach the pickup. An estimate."><Input id="s-travel" type="number" min={0} max={600} value={f.travel_to_pickup_minutes} onChange={num('travel_to_pickup_minutes')} /></Field>
        <Field label="Post-trip buffer (min)" htmlFor="s-buffer" help="Time after drop-off before the driver is free."><Input id="s-buffer" type="number" min={0} max={600} value={f.post_trip_buffer_minutes} onChange={num('post_trip_buffer_minutes')} /></Field>
        <Field label="Congestion surcharge ($)" htmlFor="s-cong" help="Shown as a separate line on NYC trips when it applies."><Input id="s-cong" inputMode="decimal" value={congestion} onChange={(e) => setCongestion(e.target.value)} /></Field>
        <Field label="Short-notice window (hours)" htmlFor="s-window" help="Driver reductions inside this window need your approval. 0 = off."><Input id="s-window" type="number" min={0} max={336} value={f.short_notice_window_hours} onChange={num('short_notice_window_hours')} /></Field>
        <Field label="Weekly submission deadline (for reminders)" htmlFor="s-dow">
          <div className="flex gap-2">
            <Select id="s-dow" value={f.submission_deadline_dow} onChange={(e) => setF({ ...f, submission_deadline_dow: Number(e.target.value) })}>{WEEKDAY_LONG.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}</Select>
            <Input type="time" aria-label="Deadline time" value={f.submission_deadline_time.slice(0, 5)} onChange={(e) => setF({ ...f, submission_deadline_time: e.target.value })} />
          </div>
        </Field>
        <Field label="Weekly reminder email" htmlFor="s-rdow">
          <div className="flex gap-2">
            <Select id="s-rdow" value={f.reminder_dow} onChange={(e) => setF({ ...f, reminder_dow: Number(e.target.value) })}>{WEEKDAY_LONG.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}</Select>
            <Input type="time" step={3600} aria-label="Reminder time" value={f.reminder_time.slice(0, 5)} onChange={(e) => setF({ ...f, reminder_time: e.target.value })} />
          </div>
        </Field>
        <Field label="Sync window: days back" htmlFor="s-past"><Input id="s-past" type="number" min={0} max={365} value={f.sync_window_past_days} onChange={num('sync_window_past_days')} /></Field>
        <Field label="Sync window: days ahead" htmlFor="s-future"><Input id="s-future" type="number" min={1} max={730} value={f.sync_window_future_days} onChange={num('sync_window_future_days')} /></Field>
        <Field label="Warn when reservations are older than (hours)" htmlFor="s-stale"><Input id="s-stale" type="number" min={1} max={720} value={f.stale_after_hours} onChange={num('stale_after_hours')} /></Field>
      </div>
      <div className="mt-4 space-y-1">
        <Checkbox label="New drivers need approval" description="Recommended. If off, anyone who signs up can use the app immediately." checked={f.require_approval} onChange={(v) => setF({ ...f, require_approval: v })} />
        <Checkbox label="Assume company preset when a reservation has no payout" description="Shown as 'assumed preset' on every match. If off, unknown payouts show as Review required." checked={f.assume_preset_when_payout_missing} onChange={(v) => setF({ ...f, assume_preset_when_payout_missing: v })} />
        <Checkbox label="Send the weekly reminder" checked={f.reminder_enabled} onChange={(v) => setF({ ...f, reminder_enabled: v })} />
      </div>
      <Button className="mt-4" onClick={() => void save()} loading={busy}>Save settings</Button>
    </Card>
  );
}

function Destinations() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['destinations-all'], queryFn: () => listDestinations(true) });
  const [editing, setEditing] = useState<DestinationRow | 'new' | null>(null);
  return (
    <Card title="Destinations, company payouts and trip durations" actions={<Button size="sm" onClick={() => setEditing('new')}>+ Add destination</Button>}>
      <p className="mb-2 text-sm text-[var(--muted)]">Company default <strong>driver payouts</strong> (not passenger prices). Trip durations are estimates used for matching; trips to a destination without a duration show as Review required.</p>
      {q.isLoading ? <Loading /> : (
        <div className="overflow-x-auto"><table className="w-full min-w-[36rem] text-sm">
          <thead className="text-left text-[var(--muted)]"><tr><th className="py-1 font-medium">Code</th><th className="font-medium">Name</th><th className="font-medium">Payout</th><th className="font-medium">Est. trip</th><th className="font-medium">Congestion</th><th /></tr></thead>
          <tbody>{(q.data ?? []).map((d) => (
            <tr key={d.id} className="border-t border-[var(--border)]">
              <td className="py-2 font-mono">{d.code}</td><td>{d.name} {!d.is_active && <Badge>inactive</Badge>}</td>
              <td>{d.preset_payout_cents ? formatUSD(d.preset_payout_cents) : 'varies'}</td>
              <td>{d.est_duration_minutes ? `${d.est_duration_minutes} min` : <Badge tone="amber">not set</Badge>}</td>
              <td>{d.congestion_eligible ? 'Can apply' : '—'}</td>
              <td className="text-right"><Button variant="ghost" size="sm" onClick={() => setEditing(d)}>Edit</Button></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <DestinationDialog dest={editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await qc.invalidateQueries({ queryKey: ['destinations-all'] }); await qc.invalidateQueries({ queryKey: ['destinations'] }); }} />
    </Card>
  );
}

function DestinationDialog({ dest, onClose, onSaved }: { dest: DestinationRow | 'new' | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [f, setF] = useState({ code: '', name: '', payout: '', duration: '', congestion: false, active: true, sort: '100' });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!dest) return;
    if (dest === 'new') setF({ code: '', name: '', payout: '', duration: '', congestion: false, active: true, sort: '100' });
    else setF({ code: dest.code, name: dest.name, payout: String(dest.preset_payout_cents / 100), duration: dest.est_duration_minutes ? String(dest.est_duration_minutes) : '', congestion: dest.congestion_eligible, active: dest.is_active, sort: String(dest.sort_order) });
  }, [dest]);
  const save = async () => {
    const payout = parseDollars(f.payout || '0');
    if (payout === null) { toast('error', 'Payout must be a dollar amount.'); return; }
    if (!/^[A-Z0-9_]{2,16}$/.test(f.code)) { toast('error', 'Code: 2–16 capital letters, digits or _.'); return; }
    setBusy(true);
    try {
      await saveDestination({ code: f.code, name: f.name.trim() || f.code, kind: dest !== 'new' && dest ? dest.kind : 'CUSTOM', preset_payout_cents: payout,
        est_duration_minutes: f.duration ? Number(f.duration) : null, congestion_eligible: f.congestion, is_active: f.active, sort_order: Number(f.sort) || 100 },
        dest === 'new' ? undefined : dest!.id, dest === 'new' ? undefined : dest!.version);
      toast('success', 'Destination saved');
      await onSaved();
    } catch (e) { toast('error', toAppError(e).message); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open={!!dest} onClose={onClose} title={dest === 'new' ? 'Add destination' : 'Edit destination'} footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={() => void save()} loading={busy}>Save</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Code" htmlFor="d-code" help="e.g. HPN"><Input id="d-code" value={f.code} disabled={dest !== 'new'} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
        <Field label="Name" htmlFor="d-name"><Input id="d-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Company driver payout ($)" htmlFor="d-pay" help="0 = varies by trip"><Input id="d-pay" inputMode="decimal" value={f.payout} onChange={(e) => setF({ ...f, payout: e.target.value })} /></Field>
        <Field label="Estimated trip duration (min)" htmlFor="d-dur"><Input id="d-dur" type="number" min={1} max={1440} value={f.duration} onChange={(e) => setF({ ...f, duration: e.target.value })} /></Field>
        <Field label="Sort order" htmlFor="d-sort"><Input id="d-sort" type="number" value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })} /></Field>
      </div>
      <Checkbox label="Congestion pricing can apply" checked={f.congestion} onChange={(v) => setF({ ...f, congestion: v })} />
      <Checkbox label="Active (offered to drivers)" checked={f.active} onChange={(v) => setF({ ...f, active: v })} />
    </Dialog>
  );
}

function ParsingSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['parsing'], queryFn: listParsingConfig });
  const dests = useQuery({ queryKey: ['destinations-all'], queryFn: () => listDestinations(true) });
  const [newRate, setNewRate] = useState({ pattern: '', destination_code: '', congestion: '', priority: '50' });
  const [newRule, setNewRule] = useState({ field: 'payout', source: 'DESCRIPTION', pattern: '', priority: '10' });
  const refresh = () => qc.invalidateQueries({ queryKey: ['parsing'] });
  const guard = (p: string) => { const err = validatePattern(p); if (err) toast('error', err); return !err; };

  return (
    <Card title="Reservation parsing">
      <p className="mb-3 text-sm text-[var(--muted)]">How Google Calendar events become reservations. Changes apply on the next sync. Patterns are regular expressions; the first group captures the value.</p>
      {q.isLoading ? <Loading /> : q.error ? <ErrorNotice error={q.error} /> : (
        <div className="space-y-6">
          <div>
            <h3 className="mb-1 text-sm font-semibold">Rate line → destination</h3>
            <table className="w-full text-sm"><tbody>
              {q.data!.rates.map((m) => (
                <tr key={m.id} className="border-t border-[var(--border)]">
                  <td className="py-1.5 font-mono text-xs">{m.pattern}</td><td>{m.destination_code}</td><td>{m.congestion === 'YES' ? 'congestion applies' : ''}</td><td className="text-xs text-[var(--muted)]">priority {m.priority}</td>
                  <td className="text-right"><Button variant="ghost" size="sm" onClick={async () => { if (await confirm({ title: 'Delete this mapping?', danger: true, confirmLabel: 'Delete' })) { await deleteRateMapping(m.id); await refresh(); } }}>Delete</Button></td>
                </tr>
              ))}
            </tbody></table>
            <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-5">
              <Input className="md:col-span-2" placeholder="Pattern, e.g. ^Westchester" value={newRate.pattern} onChange={(e) => setNewRate({ ...newRate, pattern: e.target.value })} aria-label="Pattern" />
              <Select value={newRate.destination_code} onChange={(e) => setNewRate({ ...newRate, destination_code: e.target.value })} aria-label="Destination"><option value="">Destination…</option>{(dests.data ?? []).map((d) => <option key={d.code} value={d.code}>{d.code}</option>)}</Select>
              <Select value={newRate.congestion} onChange={(e) => setNewRate({ ...newRate, congestion: e.target.value })} aria-label="Congestion"><option value="">Congestion: leave</option><option value="YES">Congestion applies</option><option value="NO">No congestion</option></Select>
              <Button onClick={async () => {
                if (!newRate.pattern || !newRate.destination_code || !guard(newRate.pattern)) return;
                try { await upsertRateMapping({ pattern: newRate.pattern, destination_code: newRate.destination_code, congestion: newRate.congestion || null, priority: Number(newRate.priority) || 50 }); setNewRate({ pattern: '', destination_code: '', congestion: '', priority: '50' }); await refresh(); toast('success', 'Mapping added'); }
                catch (e) { toast('error', toAppError(e).message); }
              }}>Add</Button>
            </div>
          </div>
          <div>
            <h3 className="mb-1 text-sm font-semibold">Field rules</h3>
            <div className="max-h-72 overflow-y-auto"><table className="w-full text-sm"><tbody>
              {q.data!.rules.map((r) => (
                <tr key={r.id} className="border-t border-[var(--border)]">
                  <td className="py-1.5">{r.field}</td><td className="text-xs">{r.source.toLowerCase()}</td><td className="font-mono text-xs">{r.pattern}</td><td className="text-xs text-[var(--muted)]">{r.priority}</td>
                  <td><Checkbox label="on" checked={r.enabled} onChange={async (v) => { await upsertParsingRule({ ...r, enabled: v }); await refresh(); }} /></td>
                  <td className="text-right"><Button variant="ghost" size="sm" onClick={async () => { if (await confirm({ title: 'Delete this rule?', danger: true, confirmLabel: 'Delete' })) { await deleteParsingRule(r.id); await refresh(); } }}>Delete</Button></td>
                </tr>
              ))}
            </tbody></table></div>
            <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-5">
              <Select value={newRule.field} onChange={(e) => setNewRule({ ...newRule, field: e.target.value })} aria-label="Field">
                {['payout', 'passengers', 'checkedBags', 'carryOnBags', 'flight', 'rateLabel', 'driverLine', 'vehicle', 'pickupAddress', 'dropoffAddress', 'tripRef', 'tripStatus', 'customerName', 'pickupTimeText'].map((x) => <option key={x}>{x}</option>)}
              </Select>
              <Select value={newRule.source} onChange={(e) => setNewRule({ ...newRule, source: e.target.value })} aria-label="Source"><option>DESCRIPTION</option><option>SUMMARY</option><option>LOCATION</option></Select>
              <Input className="md:col-span-2" placeholder="e.g. ^\s*Driver pay:\s*\$?([\d.]+)" value={newRule.pattern} onChange={(e) => setNewRule({ ...newRule, pattern: e.target.value })} aria-label="Pattern" />
              <Button onClick={async () => {
                if (!newRule.pattern || !guard(newRule.pattern)) return;
                try { await upsertParsingRule({ field: newRule.field, source: newRule.source, pattern: newRule.pattern, priority: Number(newRule.priority) || 10, enabled: true }); setNewRule({ ...newRule, pattern: '' }); await refresh(); toast('success', 'Rule added'); }
                catch (e) { toast('error', toAppError(e).message); }
              }}>Add</Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

function Aliases() {
  const qc = useQueryClient();
  const toast = useToast();
  const aliases = useQuery({ queryKey: ['aliases'], queryFn: listAliases });
  const drivers = useQuery({ queryKey: ['drivers'], queryFn: listDrivers });
  const [driver, setDriver] = useState('');
  const [alias, setAlias] = useState('');
  const name = (id: string) => drivers.data?.find((d) => d.user_id === id)?.full_name ?? '?';
  return (
    <Card title="Driver name aliases">
      <p className="mb-2 text-sm text-[var(--muted)]">How a driver's name appears in Google Calendar, if different from their profile (e.g. "Chuck Handy" for "Charles Handy").</p>
      <ul className="mb-3 flex flex-wrap gap-2">{(aliases.data ?? []).map((a) => (
        <li key={a.id} className="flex items-center gap-1 rounded-full border border-[var(--border)] px-3 py-1 text-sm">"{a.alias}" → {name(a.driver_id)}
          <button className="ml-1 text-[var(--muted)]" aria-label={`Remove alias ${a.alias}`} onClick={async () => { await deleteAlias(a.id); await qc.invalidateQueries({ queryKey: ['aliases'] }); }}>✕</button></li>
      ))}</ul>
      <div className="flex flex-wrap gap-2">
        <Input className="max-w-xs" placeholder="Name as written in the calendar" value={alias} onChange={(e) => setAlias(e.target.value)} aria-label="Alias" />
        <Select className="max-w-xs" value={driver} onChange={(e) => setDriver(e.target.value)} aria-label="Driver"><option value="">Driver…</option>{(drivers.data ?? []).filter((d) => d.status === 'APPROVED').map((d) => <option key={d.user_id} value={d.user_id}>{d.full_name || d.email}</option>)}</Select>
        <Button disabled={!alias.trim() || !driver} onClick={async () => {
          try { await addAlias(driver, alias.trim()); setAlias(''); await qc.invalidateQueries({ queryKey: ['aliases'] }); toast('success', 'Alias added; it applies on the next sync'); }
          catch (e) { toast('error', toAppError(e).message); }
        }}>Add alias</Button>
      </div>
    </Card>
  );
}

function Notifications() {
  const qc = useQueryClient();
  const toast = useToast();
  const cats = useQuery({ queryKey: ['notif-cats'], queryFn: listNotificationCategories });
  const [busy, setBusy] = useState(false);
  const toggle = async (code: string, enabled: boolean) => {
    try {
      const { error } = await supabase.from('notification_categories').update({ enabled_globally: enabled }).eq('code', code);
      if (error) throw error;
      await qc.invalidateQueries({ queryKey: ['notif-cats'] });
      toast('success', 'Saved');
    } catch (e) { toast('error', toAppError(e).message); }
  };
  return (
    <Card title="Email notifications">
      <p className="mb-2 text-sm text-[var(--muted)]">Only the weekly reminder is on by default. Others stay off unless you turn them on. Drivers can opt out in their profile.</p>
      {(cats.data ?? []).map((c) => (
        <Checkbox key={c.code} label={c.description} description={c.code === 'WEEKLY_REMINDER' ? 'Implemented and scheduled hourly by pg_cron (see setup guide).' : 'Reserved for later; turning it on records the preference but no emails are sent for it yet.'}
          checked={c.enabled_globally} onChange={(v) => void toggle(c.code, v)} disabled={c.code !== 'WEEKLY_REMINDER'} />
      ))}
      <Notice tone="info">Sending now emails every opted-in approved driver who hasn't had this week's reminder.</Notice>
      <Button className="mt-3" variant="outline" loading={busy} onClick={async () => {
        setBusy(true);
        try { const r = await sendRemindersNow(); toast('success', `Reminders: ${r.sent} sent, ${r.failed} failed${r.deferred ? `, ${r.deferred} deferred (daily cap)` : ''}`); }
        catch (e) { toast('error', toAppError(e).message); }
        finally { setBusy(false); }
      }}>Send this week's reminder now</Button>
    </Card>
  );
}
