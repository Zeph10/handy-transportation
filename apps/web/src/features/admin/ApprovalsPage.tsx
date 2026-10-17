import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDayTime } from '@handy/core';
import { Button, Card, EmptyState, ErrorNotice, Input, Loading, PageHeader, useToast } from '@/components/ui';
import { decideChangeRequest, listDrivers, listPendingChangeRequests, setDriverStatus } from '@/lib/api';
import { toAppError } from '@/lib/errors';
import { describeRequest } from '@/lib/describe';

export default function ApprovalsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const drivers = useQuery({ queryKey: ['drivers'], queryFn: listDrivers });
  const requests = useQuery({ queryKey: ['pending-requests'], queryFn: listPendingChangeRequests });
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const pending = (drivers.data ?? []).filter((d) => d.status === 'PENDING_APPROVAL');
  const name = (id: string) => drivers.data?.find((d) => d.user_id === id)?.full_name ?? 'Driver';

  const decideDriver = async (id: string, approve: boolean) => {
    setBusy(id);
    try {
      await setDriverStatus(id, approve ? 'APPROVED' : 'REJECTED', reasons[id]);
      toast('success', approve ? 'Driver approved: they can log in now' : 'Registration rejected');
      await qc.invalidateQueries({ queryKey: ['drivers'] });
    } catch (e) { toast('error', toAppError(e).message); }
    finally { setBusy(null); }
  };
  const decideRequest = async (id: string, approve: boolean) => {
    setBusy(id);
    try {
      await decideChangeRequest(id, approve, reasons[id]);
      toast('success', approve ? 'Change approved and applied' : 'Change declined; the original availability stays');
      await Promise.all([qc.invalidateQueries({ queryKey: ['pending-requests'] }), qc.invalidateQueries({ queryKey: ['admin-dataset'] })]);
    } catch (e) { toast('error', toAppError(e).message); }
    finally { setBusy(null); }
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Approvals" />
      <Card title={`New driver registrations (${pending.length})`}>
        {drivers.isLoading ? <Loading /> : drivers.error ? <ErrorNotice error={drivers.error} /> : pending.length === 0 ? <EmptyState title="No one is waiting" /> : (
          <ul className="divide-y divide-[var(--border)]">
            {pending.map((d) => (
              <li key={d.user_id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-48 flex-1">
                  <Link to={`/admin/drivers/${d.user_id}`} className="font-medium hover:underline">{d.full_name || '(no name given)'}</Link>
                  <p className="text-sm text-[var(--muted)]">{d.email} · signed up {formatDayTime(Date.parse(d.created_at))}</p>
                </div>
                <Input className="max-w-xs" placeholder="Note to driver (optional)" value={reasons[d.user_id] ?? ''} onChange={(e) => setReasons({ ...reasons, [d.user_id]: e.target.value })} aria-label="Note" />
                <Button onClick={() => void decideDriver(d.user_id, true)} loading={busy === d.user_id}>Approve</Button>
                <Button variant="outline" onClick={() => void decideDriver(d.user_id, false)} disabled={busy === d.user_id}>Reject</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title={`Short-notice changes (${requests.data?.length ?? 0})`}>
        <p className="mb-2 text-sm text-[var(--muted)]">A driver tried to reduce availability inside the short-notice window. Nothing changes until you approve.</p>
        {requests.isLoading ? <Loading /> : requests.error ? <ErrorNotice error={requests.error} /> : (requests.data ?? []).length === 0 ? <EmptyState title="Nothing waiting" /> : (
          <ul className="divide-y divide-[var(--border)]">
            {requests.data!.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-48 flex-1">
                  <p className="font-medium">{name(r.driver_id)}: {describeRequest(r)}</p>
                  <p className="text-sm text-[var(--muted)]">Requested {formatDayTime(Date.parse(r.created_at))}{r.driver_message ? ` · "${r.driver_message}"` : ''}</p>
                </div>
                <Input className="max-w-xs" placeholder="Reason (optional)" value={reasons[r.id] ?? ''} onChange={(e) => setReasons({ ...reasons, [r.id]: e.target.value })} aria-label="Reason" />
                <Button onClick={() => void decideRequest(r.id, true)} loading={busy === r.id}>Approve</Button>
                <Button variant="outline" onClick={() => void decideRequest(r.id, false)} disabled={busy === r.id}>Decline</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
