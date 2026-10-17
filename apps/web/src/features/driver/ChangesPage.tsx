import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDayTime } from '@handy/core';
import { Badge, Button, Card, EmptyState, ErrorNotice, Loading, PageHeader, useToast } from '@/components/ui';
import { listMyChangeRequests, myAdminChanges, withdrawChangeRequest } from '@/lib/api';
import { toAppError } from '@/lib/errors';
import { describeChange, describeRequest } from '@/lib/describe';
import { useUserId } from '@/features/auth/session';

export function ChangesPage() {
  const driverId = useUserId();
  const qc = useQueryClient();
  const toast = useToast();
  const requests = useQuery({ queryKey: ['my-requests', driverId], queryFn: () => listMyChangeRequests(driverId) });
  const admin = useQuery({ queryKey: ['my-admin-changes'], queryFn: myAdminChanges });

  const withdraw = async (id: string) => {
    try { await withdrawChangeRequest(id); toast('success', 'Request withdrawn'); await qc.invalidateQueries({ queryKey: ['my-requests', driverId] }); }
    catch (e) { toast('error', toAppError(e).message); }
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Changes & requests" subtitle="Short-notice changes waiting for approval, and changes the dispatcher made to your availability." />
      <Card title="Your requests">
        {requests.isLoading ? <Loading /> : requests.error ? <ErrorNotice error={requests.error} /> : (requests.data ?? []).length === 0 ? (
          <EmptyState title="No requests" />
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {requests.data!.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div>
                  <p className="text-sm font-medium">{describeRequest(r)}</p>
                  <p className="text-xs text-[var(--muted)]">Requested {formatDayTime(Date.parse(r.created_at))}{r.decision_reason && ` · Dispatcher: ${r.decision_reason}`}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={r.status === 'PENDING' ? 'amber' : r.status === 'APPROVED' ? 'green' : r.status === 'REJECTED' ? 'red' : 'gray'}>
                    {r.status === 'PENDING' ? 'Waiting' : r.status === 'APPROVED' ? 'Approved' : r.status === 'REJECTED' ? 'Declined' : 'Withdrawn'}
                  </Badge>
                  {r.status === 'PENDING' && <Button variant="ghost" size="sm" onClick={() => void withdraw(r.id)}>Withdraw</Button>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Changes by the dispatcher">
        {admin.isLoading ? <Loading /> : admin.error ? <ErrorNotice error={admin.error} /> : (admin.data ?? []).length === 0 ? (
          <EmptyState title="No changes by the dispatcher" />
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {admin.data!.map((a) => (
              <li key={a.id} className="py-3">
                <p className="text-sm font-medium">{describeChange(a)}</p>
                {a.reason && <p className="text-sm">Reason: {a.reason}</p>}
                <p className="text-xs text-[var(--muted)]">{formatDayTime(Date.parse(a.created_at))}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
