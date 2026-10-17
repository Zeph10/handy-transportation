import { Fragment, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { formatDayTime } from '@handy/core';
import { Badge, Button, ErrorNotice, Loading, PageHeader, Select } from '@/components/ui';
import { listAudit, listDrivers } from '@/lib/api';
import { describeChange } from '@/lib/describe';

const TABLES = ['availability_blocks', 'availability_rules', 'rule_exceptions', 'time_off', 'admin_unavailability', 'change_requests', 'driver_profiles', 'vehicles',
  'driver_destination_defaults', 'destinations', 'app_settings', 'reservation_corrections', 'eligibility_overrides', 'calendar_connections', 'sync_runs', 'parsing_rules', 'rate_mappings', 'driver_aliases', 'user_roles'];

export default function AuditPage() {
  const drivers = useQuery({ queryKey: ['drivers'], queryFn: listDrivers });
  const [driverId, setDriverId] = useState('');
  const [table, setTable] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const q = useInfiniteQuery({
    queryKey: ['audit-log', driverId, table],
    queryFn: ({ pageParam }) => listAudit({ driverId: driverId || undefined, table: table || undefined, limit: 100, before: pageParam ?? undefined }),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => (last.length === 100 ? last[last.length - 1].id : undefined),
  });
  const name = (id: string | null) => (id ? drivers.data?.find((d) => d.user_id === id)?.full_name ?? id.slice(0, 8) : '');
  const rows = q.data?.pages.flat() ?? [];

  return (
    <div className="space-y-3">
      <PageHeader title="Audit log" subtitle="Append-only record of changes. Tokens and secrets are never stored here." />
      <div className="flex flex-wrap gap-2">
        <Select className="max-w-xs" value={driverId} onChange={(e) => setDriverId(e.target.value)} aria-label="Driver"><option value="">All drivers</option>{(drivers.data ?? []).map((d) => <option key={d.user_id} value={d.user_id}>{d.full_name || d.email}</option>)}</Select>
        <Select className="max-w-xs" value={table} onChange={(e) => setTable(e.target.value)} aria-label="Type"><option value="">All types</option>{TABLES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</Select>
      </div>
      {q.isLoading ? <Loading /> : q.error ? <ErrorNotice error={q.error} /> : (
        <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          <table className="w-full min-w-[48rem] text-sm">
            <thead className="bg-[var(--surface-2)] text-left"><tr><th className="p-2 font-medium">When</th><th className="p-2 font-medium">Who</th><th className="p-2 font-medium">Driver affected</th><th className="p-2 font-medium">What</th><th className="p-2 font-medium">Reason</th><th /></tr></thead>
            <tbody>
              {rows.map((a) => (
                <Fragment key={a.id}>
                  <tr className="border-t border-[var(--border)]">
                    <td className="p-2 whitespace-nowrap">{formatDayTime(Date.parse(a.created_at))}</td>
                    <td className="p-2"><Badge tone={a.actor_role === 'ADMIN' ? 'purple' : a.actor_role === 'SYSTEM' ? 'gray' : 'blue'}>{a.actor_role?.toLowerCase() ?? 'system'}</Badge> {name(a.actor_id)}</td>
                    <td className="p-2">{name(a.affected_driver_id)}</td>
                    <td className="p-2">{describeChange(a)} <span className="text-xs text-[var(--muted)]">({a.entity_table})</span></td>
                    <td className="p-2">{a.reason}</td>
                    <td className="p-2 text-right"><Button variant="ghost" size="sm" onClick={() => setOpen(open === a.id ? null : a.id)} aria-expanded={open === a.id}>{open === a.id ? 'Hide' : 'Details'}</Button></td>
                  </tr>
                  {open === a.id && (
                    <tr className="bg-[var(--surface-2)]"><td colSpan={6} className="p-2">
                      <div className="grid gap-2 md:grid-cols-2">
                        <div><p className="text-xs font-semibold">Before</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(a.before, null, 2)}</pre></div>
                        <div><p className="text-xs font-semibold">After</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(a.after, null, 2)}</pre></div>
                      </div>
                    </td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {q.hasNextPage && <Button variant="outline" onClick={() => void q.fetchNextPage()} loading={q.isFetchingNextPage}>Load more</Button>}
    </div>
  );
}
