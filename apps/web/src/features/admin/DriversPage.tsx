import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { formatLocalDate } from '@handy/core';
import { Badge, ErrorNotice, Input, Loading, PageHeader, Select } from '@/components/ui';
import { listAllVehicles, listDrivers } from '@/lib/api';
import type { DriverStatus } from '@/lib/types';

export const STATUS_BADGE: Record<DriverStatus, { label: string; tone: 'green' | 'amber' | 'red' | 'gray' }> = {
  APPROVED: { label: 'Approved', tone: 'green' },
  PENDING_APPROVAL: { label: 'Pending', tone: 'amber' },
  REJECTED: { label: 'Rejected', tone: 'red' },
  SUSPENDED: { label: 'Suspended', tone: 'gray' },
};

export default function DriversPage() {
  const drivers = useQuery({ queryKey: ['drivers'], queryFn: listDrivers });
  const vehicles = useQuery({ queryKey: ['all-vehicles'], queryFn: listAllVehicles });
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'' | DriverStatus>('');
  const rows = useMemo(() => (drivers.data ?? [])
    .filter((d) => !status || d.status === status)
    .filter((d) => !q || `${d.full_name} ${d.email} ${d.phone ?? ''}`.toLowerCase().includes(q.toLowerCase())), [drivers.data, q, status]);

  return (
    <div className="space-y-3">
      <PageHeader title="Drivers" subtitle={`${(drivers.data ?? []).filter((d) => d.status === 'APPROVED').length} approved`} />
      <div className="flex flex-wrap gap-2">
        <Input className="max-w-xs" placeholder="Search name, email, phone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search drivers" />
        <Select className="max-w-48" value={status} onChange={(e) => setStatus(e.target.value as DriverStatus | '')} aria-label="Filter by status">
          <option value="">All statuses</option>
          {Object.entries(STATUS_BADGE).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </Select>
      </div>
      {drivers.isLoading ? <Loading /> : drivers.error ? <ErrorNotice error={drivers.error} /> : (
        <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="bg-[var(--surface-2)] text-left"><tr><th className="p-2 font-medium">Name</th><th className="p-2 font-medium">Status</th><th className="p-2 font-medium">Contact</th><th className="p-2 font-medium">Vehicles</th><th className="p-2 font-medium">Joined</th></tr></thead>
            <tbody>
              {rows.map((d) => {
                const vs = (vehicles.data ?? []).filter((v) => v.driver_id === d.user_id);
                return (
                  <tr key={d.user_id} className="border-t border-[var(--border)] hover:bg-[var(--surface-2)]">
                    <td className="p-2"><Link to={`/admin/drivers/${d.user_id}`} className="font-medium text-brand-700 hover:underline dark:text-brand-500">{d.full_name || '(no name yet)'}</Link></td>
                    <td className="p-2"><Badge tone={STATUS_BADGE[d.status].tone}>{STATUS_BADGE[d.status].label}</Badge></td>
                    <td className="p-2">{d.email}{d.phone && <span className="block text-xs text-[var(--muted)]">{d.phone}</span>}</td>
                    <td className="p-2">{vs.map((v) => `${v.name} (${v.max_passengers})`).join(', ') || '—'}</td>
                    <td className="p-2">{formatLocalDate(d.created_at.slice(0, 10))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
