import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { addDays, formatDayTime, formatLocalDate, formatUSD, localToInstant, startOfWeek, todayLocal } from '@handy/core';
import { Badge, Card, ErrorNotice, Loading, PageHeader, cx } from '@/components/ui';
import { listPendingChangeRequests } from '@/lib/api';
import { hasAnyAvailability, weeklyHeatmap } from '@/lib/dashboard';
import { driverTimeline, findConflicts, matchOne, reservationPayout } from '@/lib/matchInputs';
import { WEEKDAY_NAMES } from '@/lib/style';
import { SyncBanner } from './SyncBanner';
import { useAdminDataset } from './useAdminData';

export default function DashboardPage() {
  const today = todayLocal();
  const monday = startOfWeek(today);
  const nextMonday = addDays(monday, 7);
  const data = useAdminDataset(monday, addDays(monday, 13));
  const pendingReq = useQuery({ queryKey: ['pending-requests'], queryFn: listPendingChangeRequests });

  const view = useMemo(() => {
    const ds = data.data;
    if (!ds) return null;
    const approved = ds.drivers.filter((d) => d.status === 'APPROVED');
    const weekStart = localToInstant(monday, '00:00');
    const weekEnd = localToInstant(nextMonday, '00:00');
    const timelines = new Map(approved.map((d) => [d.user_id, driverTimeline(ds.schedules.get(d.user_id), weekStart, weekEnd)]));
    const heat = weeklyHeatmap(monday, approved.map((d) => timelines.get(d.user_id)!));
    const nextWeek = new Map(approved.map((d) => [d.user_id, driverTimeline(ds.schedules.get(d.user_id), localToInstant(nextMonday, '00:00'), localToInstant(addDays(nextMonday, 7), '00:00'))
      .filter((s) => s.start >= localToInstant(nextMonday, '00:00') && s.start < localToInstant(addDays(nextMonday, 7), '00:00'))]));
    const missingNextWeek = approved.filter((d) => !hasAnyAvailability(nextWeek.get(d.user_id) ?? []));
    const now = Date.now();
    const upcoming = ds.reservations.filter((r) => r.is_reservation && !r.removed_from_source && r.pickup_at && Date.parse(r.pickup_at) >= now);
    const unfilled = upcoming.filter((r) => r.assignment === 'UNFILLED');
    const matches = new Map(unfilled.map((r) => [r.id, matchOne(r, ds)]));
    const zeroEligible = unfilled.filter((r) => { const m = matches.get(r.id)!; return m.eligible.length === 0 && m.tentative.length === 0; });
    const review = upcoming.filter((r) => r.review_flags.length > 0 || r.assignment === 'ASSIGNED_UNKNOWN');
    const conflicts = findConflicts(ds);
    const next7 = upcoming.filter((r) => Date.parse(r.pickup_at!) < now + 7 * 86_400_000);
    let payoutKnown = 0, payoutAssumed = 0, payoutUnknown = 0;
    for (const r of next7) {
      const p = reservationPayout(r, ds);
      if (p.totalCents === null) payoutUnknown++;
      else if (p.baseSource === 'ASSUMED_PRESET') payoutAssumed += p.totalCents;
      else payoutKnown += p.totalCents;
    }
    const workload = approved.map((d) => ({
      d,
      count: upcoming.filter((r) => r.assignment === 'ASSIGNED' && r.assigned_driver_id === d.user_id && Date.parse(r.pickup_at!) < now + 14 * 86_400_000).length,
      availableHours: Math.round((timelines.get(d.user_id) ?? []).filter((s) => s.status === 'AVAILABLE').reduce((a, s) => a + (s.end - s.start), 0) / 3_600_000),
    })).sort((a, b) => b.count - a.count || a.d.full_name.localeCompare(b.d.full_name));
    const pendingDrivers = ds.drivers.filter((d) => d.status === 'PENDING_APPROVAL');
    return { approved, heat, missingNextWeek, unfilled, matches, zeroEligible, review, conflicts, next7, payoutKnown, payoutAssumed, payoutUnknown, workload, pendingDrivers };
  }, [data.data, monday, nextMonday]);

  if (data.isLoading) return <Loading />;
  if (data.error) return <ErrorNotice error={data.error} onRetry={() => void data.refetch()} />;
  if (!view) return null;
  const maxHeat = Math.max(1, ...view.heat.flat().map((c) => c.confirmed + c.tentative));

  return (
    <div className="space-y-4">
      <PageHeader title="Dashboard" subtitle={`Week of ${formatLocalDate(monday)}`} />
      <SyncBanner />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <Stat label="Approved drivers" value={view.approved.length} to="/admin/drivers" />
        <Stat label="Unfilled upcoming" value={view.unfilled.length} tone={view.unfilled.length ? 'amber' : undefined} to="/admin/reservations?filter=unfilled" />
        <Stat label="Zero eligible drivers" value={view.zeroEligible.length} tone={view.zeroEligible.length ? 'red' : undefined} to="/admin/reservations?filter=unfilled" />
        <Stat label="Need review" value={view.review.length} tone={view.review.length ? 'amber' : undefined} to="/admin/reservations?filter=review" />
        <Stat label="Conflicts" value={view.conflicts.size} tone={view.conflicts.size ? 'red' : undefined} to="/admin/calendar" />
        <Stat label="Approvals waiting" value={view.pendingDrivers.length + (pendingReq.data?.length ?? 0)} tone={view.pendingDrivers.length + (pendingReq.data?.length ?? 0) ? 'amber' : undefined} to="/admin/approvals" />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card title="Unfilled reservations" className="xl:col-span-2" actions={<Link to="/admin/reservations?filter=unfilled" className="text-sm text-brand-700 underline">All</Link>}>
          {view.unfilled.length === 0 ? <p className="text-sm text-[var(--muted)]">No unfilled reservations in the next two weeks.</p> : (
            <ul className="divide-y divide-[var(--border)]">
              {view.unfilled.slice(0, 12).map((r) => {
                const m = view.matches.get(r.id)!;
                return (
                  <li key={r.id}>
                    <Link to={`/admin/reservations/${r.id}`} className="flex flex-wrap items-center gap-2 py-2 hover:bg-[var(--surface-2)]">
                      <span className="w-44 text-sm font-medium">{formatDayTime(Date.parse(r.pickup_at!))}</span>
                      <Badge tone="purple">{r.destination_code ?? 'Unknown'}</Badge>
                      <span className="text-sm">{r.passengers ?? '?'} pax</span>
                      <span className="text-sm text-[var(--muted)]">{r.trip_ref}</span>
                      <span className="ml-auto flex gap-1">
                        {m.eligible.length > 0 && <Badge tone="green">{m.eligible.length} eligible</Badge>}
                        {m.tentative.length > 0 && <Badge tone="amber">{m.tentative.length} tentative</Badge>}
                        {m.review.length > 0 && <Badge>{m.review.length} review</Badge>}
                        {m.eligible.length + m.tentative.length === 0 && <Badge tone="red">No eligible drivers</Badge>}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <Card title="Estimated payouts, next 7 days">
          <p className="text-2xl font-semibold">{formatUSD(view.payoutKnown)}</p>
          <p className="text-sm text-[var(--muted)]">from payouts stated or corrected on reservations</p>
          <p className="mt-2 text-sm">+ {formatUSD(view.payoutAssumed)} assumed from company presets</p>
          {view.payoutUnknown > 0 && <p className="text-sm text-amber-700 dark:text-amber-300">{view.payoutUnknown} reservation{view.payoutUnknown > 1 ? 's' : ''} with unknown payout</p>}
          <p className="mt-2 text-xs text-[var(--muted)]">Includes congestion surcharges where marked. {view.next7.length} reservations.</p>
        </Card>
      </div>

      <Card title="Drivers available by hour (this week)" actions={<span className="text-xs text-[var(--muted)]">number = confirmed; +n = tentative; unknown not counted</span>}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[46rem] border-separate border-spacing-0.5 text-center text-[11px]">
            <thead><tr><th className="w-10" />{Array.from({ length: 24 }, (_, h) => <th key={h} className="font-normal text-[var(--muted)]">{h % 3 === 0 ? `${((h + 11) % 12) + 1}${h < 12 ? 'a' : 'p'}` : ''}</th>)}</tr></thead>
            <tbody>
              {view.heat.map((row, d) => (
                <tr key={d}>
                  <th className="pr-1 text-right font-medium">
                    <Link to={`/admin/calendar?date=${addDays(monday, d)}&view=day`} className="hover:underline">{WEEKDAY_NAMES[d]}</Link>
                  </th>
                  {row.map((c, h) => (
                    <td key={h} title={`${WEEKDAY_NAMES[d]} ${h}:00 — ${c.confirmed} confirmed, ${c.tentative} tentative`}
                      className={cx('h-7 rounded', c.confirmed + c.tentative === 0 && 'pattern-unknown')}
                      style={c.confirmed + c.tentative > 0 ? { background: `rgba(22,163,74,${0.15 + 0.75 * (c.confirmed / maxHeat)})` } : undefined}>
                      {c.confirmed > 0 && <span className="font-semibold">{c.confirmed}</span>}
                      {c.tentative > 0 && <span className="text-amber-800 dark:text-amber-300">+{c.tentative}</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`No availability shared for next week (${view.missingNextWeek.length})`}>
          {view.missingNextWeek.length === 0 ? <p className="text-sm text-[var(--muted)]">Every approved driver has shared something for next week.</p> : (
            <ul className="flex flex-wrap gap-2">
              {view.missingNextWeek.map((d) => <li key={d.user_id}><Link to={`/admin/drivers/${d.user_id}`} className="rounded-full border border-[var(--border)] px-3 py-1 text-sm hover:bg-[var(--surface-2)]">{d.full_name || d.email}</Link></li>)}
            </ul>
          )}
          <p className="mt-2 text-xs text-[var(--muted)]">Submitting is optional; this is for planning only.</p>
        </Card>
        <Card title="Workload (next 14 days)">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[var(--muted)]"><th className="font-medium">Driver</th><th className="font-medium">Assigned trips</th><th className="font-medium">Available hrs this week</th></tr></thead>
            <tbody>{view.workload.map(({ d, count, availableHours }) => (
              <tr key={d.user_id} className="border-t border-[var(--border)]"><td className="py-1.5"><Link to={`/admin/drivers/${d.user_id}`} className="hover:underline">{d.full_name || d.email}</Link></td><td>{count}</td><td>{availableHours}</td></tr>
            ))}</tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value, tone, to }: { label: string; value: number; tone?: 'amber' | 'red'; to: string }) {
  return (
    <Link to={to} className={cx('rounded-xl border bg-[var(--surface)] p-3 hover:bg-[var(--surface-2)]',
      tone === 'red' ? 'border-red-300 dark:border-red-800' : tone === 'amber' ? 'border-amber-300 dark:border-amber-800' : 'border-[var(--border)]')}>
      <p className={cx('text-2xl font-semibold', tone === 'red' && 'text-red-700 dark:text-red-300', tone === 'amber' && 'text-amber-700 dark:text-amber-300')}>{value}</p>
      <p className="text-xs text-[var(--muted)]">{label}</p>
    </Link>
  );
}
