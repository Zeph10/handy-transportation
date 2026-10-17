import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { addDays, formatDayTime, localToInstant, todayLocal } from '@handy/core';
import { Badge, Card, ErrorNotice, Field, Input, Loading, PageHeader, Select } from '@/components/ui';
import { matchOne } from '@/lib/matchInputs';
import { SyncBanner } from './SyncBanner';
import { useAdminDataset } from './useAdminData';

const FLAG_TEXT: Record<string, string> = {
  MISSING_PICKUP_TIME: 'pickup time missing', MISSING_DESTINATION: 'destination unknown', MISSING_PASSENGERS: 'passenger count missing',
  UNRECOGNIZED_RATE: 'rate not recognized', DESTINATION_INFERRED: 'destination guessed from address', PICKUP_TIME_MISMATCH: 'pickup time text differs from event time',
  UNKNOWN_DRIVER_NAME: 'driver name not matched', DRIVER_MATCHED_BY_EMAIL: 'driver matched by invite email', DRIVER_NAME_EMAIL_MISMATCH: 'driver name and invite differ',
  DRIVER_INVITED_BUT_NOT_NAMED: 'a driver is invited but not named', TRIP_NOT_CONFIRMED: 'trip not confirmed', ALL_DAY_EVENT: 'all-day event',
};
export const flagText = (f: string) => FLAG_TEXT[f] ?? f.toLowerCase().replace(/_/g, ' ');

export default function ReservationsPage() {
  const [params, setParams] = useSearchParams();
  const filter = params.get('filter') ?? 'all';
  const [from, setFrom] = useState(todayLocal());
  const [days, setDays] = useState(14);
  const [q, setQ] = useState('');
  const data = useAdminDataset(from, addDays(from, days - 1));

  const rows = useMemo(() => {
    const ds = data.data;
    if (!ds) return [];
    return ds.reservations
      .filter((r) => !r.pickup_at || Date.parse(r.pickup_at) >= localToInstant(from, '00:00'))
      .filter((r) => filter === 'all' ? r.is_reservation : filter === 'unfilled' ? r.is_reservation && r.assignment === 'UNFILLED'
        : filter === 'review' ? r.is_reservation && (r.review_flags.length > 0 || r.assignment === 'ASSIGNED_UNKNOWN')
        : filter === 'ignored' ? !r.is_reservation : true)
      .filter((r) => !q || [r.trip_ref, r.raw_summary, r.destination_code].some((x) => x?.toLowerCase().includes(q.toLowerCase())))
      .map((r) => ({ r, m: r.is_reservation && r.assignment === 'UNFILLED' ? matchOne(r, ds) : null }));
  }, [data.data, filter, from, q]);

  const driverName = (id: string | null) => data.data?.drivers.find((d) => d.user_id === id)?.full_name ?? '—';

  return (
    <div className="space-y-3">
      <PageHeader title="Reservations" subtitle="Imported from Google Calendar (read-only). Corrections you make stay in this app." />
      <SyncBanner />
      <Card>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Field label="Show" htmlFor="r-filter">
            <Select id="r-filter" value={filter} onChange={(e) => setParams({ filter: e.target.value })}>
              <option value="all">All reservations</option>
              <option value="unfilled">Unfilled</option>
              <option value="review">Needs review</option>
              <option value="ignored">Not reservations (ignored entries)</option>
            </Select>
          </Field>
          <Field label="From" htmlFor="r-from"><Input id="r-from" type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} /></Field>
          <Field label="Days" htmlFor="r-days"><Select id="r-days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[7, 14, 31, 62].map((d) => <option key={d} value={d}>{d}</option>)}</Select></Field>
          <Field label="Search" htmlFor="r-q"><Input id="r-q" value={q} placeholder="Trip number, text…" onChange={(e) => setQ(e.target.value)} /></Field>
        </div>
      </Card>
      {data.isLoading ? <Loading /> : data.error ? <ErrorNotice error={data.error} onRetry={() => void data.refetch()} /> : (
        <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          <table className="w-full min-w-[52rem] text-sm">
            <thead className="bg-[var(--surface-2)] text-left">
              <tr><th className="p-2 font-medium">Pickup</th><th className="p-2 font-medium">Trip</th><th className="p-2 font-medium">Destination</th><th className="p-2 font-medium">Pax</th><th className="p-2 font-medium">Driver</th><th className="p-2 font-medium">Matching / flags</th></tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-[var(--muted)]">Nothing here for this range.</td></tr>}
              {rows.map(({ r, m }) => (
                <tr key={r.id} className="border-t border-[var(--border)] hover:bg-[var(--surface-2)]">
                  <td className="p-2"><Link to={`/admin/reservations/${r.id}`} className="font-medium text-brand-700 hover:underline dark:text-brand-500">{r.pickup_at ? formatDayTime(Date.parse(r.pickup_at)) : 'Unknown'}</Link></td>
                  <td className="p-2">{r.trip_ref ?? (r.is_reservation ? '—' : <span className="text-[var(--muted)]">{r.raw_summary?.slice(0, 40)}</span>)}</td>
                  <td className="p-2">{r.destination_code ?? <Badge tone="amber">Unknown</Badge>}{r.congestion === 'YES' && <span className="ml-1 text-xs">+congestion</span>}</td>
                  <td className="p-2">{r.passengers ?? <Badge tone="amber">?</Badge>}</td>
                  <td className="p-2">{r.assignment === 'UNFILLED' ? <Badge tone="red">Unfilled</Badge> : r.assignment === 'ASSIGNED' ? driverName(r.assigned_driver_id) : r.assignment === 'ASSIGNED_UNKNOWN' ? <Badge tone="amber">{String((r.parsed as { driverName?: string }).driverName ?? 'Unknown name')}</Badge> : '—'}</td>
                  <td className="p-2">
                    <span className="flex flex-wrap gap-1">
                      {m && <>{m.eligible.length > 0 && <Badge tone="green">{m.eligible.length} eligible</Badge>}{m.tentative.length > 0 && <Badge tone="amber">{m.tentative.length} tentative</Badge>}{m.eligible.length + m.tentative.length === 0 && <Badge tone="red">none eligible</Badge>}</>}
                      {r.review_flags.slice(0, 2).map((f) => <Badge key={f} tone="amber">{flagText(f)}</Badge>)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
