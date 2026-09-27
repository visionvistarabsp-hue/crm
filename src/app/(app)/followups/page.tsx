'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useApi } from '@/lib/useApi';
import { ApiErrorView, fetcher } from '@/lib/fetcher';
import { Badge, Button, EmptyState, PageHeader, Pagination, Spinner, StatusBadge, Table } from '@/components/ui';

type Followup = {
  id: string; leadId: string | null; customerId: string | null; type: string; status: string;
  priority: string; scheduledAt: string; note: string | null; assignedTo: string | null;
  leadName?: string | null; assigneeName?: string | null;
};

export default function FollowupsPage() {
  const [params, setParams] = useState({ page: 1, pageSize: 25, view: 'today' });
  const url = useMemo(() => {
    const sp = new URLSearchParams({ page: String(params.page), pageSize: String(params.pageSize), view: params.view });
    return `/api/followups?${sp.toString()}`;
  }, [params]);
  const { data, error, loading, reload } = useApi<{ items: Followup[]; total: number }>(url, { deps: [params], refresh: 30000 });

  const complete = async (id: string) => {
    await fetcher(`/api/followups/${id}`, { method: 'POST', body: JSON.stringify({ note: 'Completed' }) });
    reload();
  };

  return (
    <div>
      <PageHeader
        title="Follow-ups"
        subtitle="Outreach scheduled across the team"
        action={<Link href="/followups/new" className="btn-primary">Schedule</Link>}
      />
      <div className="mb-4 flex flex-wrap gap-2">
        {['today', 'upcoming', 'overdue', 'completed'].map((v) => (
          <button key={v} onClick={() => setParams((p) => ({ ...p, view: v }))}
            className={params.view === v ? 'btn-primary !py-1.5 capitalize' : 'btn-secondary !py-1.5 capitalize'}>
            {v}
          </button>
        ))}
      </div>

      {loading && !data && <div className="flex justify-center p-10"><Spinner /></div>}
      <ApiErrorView error={error} onRetry={reload} />

      <div className="card">
        <Table head={['Lead/Customer', 'Type', 'Scheduled', 'Status', 'Assignee', 'Note', '']}>
          {data?.items?.map((f) => (
            <tr key={f.id}>
              <td className="td">
                <p className="font-medium text-ink">{f.leadName ?? f.customerId ?? '—'}</p>
                <p className="text-xs text-ink-faint">{f.customerId && !f.leadName ? 'Customer' : ''}</p>
              </td>
              <td className="td"><Badge tone="purple">{f.type}</Badge></td>
              <td className="td tabular-nums">{new Date(f.scheduledAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
              <td className="td"><StatusBadge status={f.status} /></td>
              <td className="td text-ink-muted">{f.assigneeName ?? '—'}</td>
              <td className="td max-w-[220px] truncate text-ink-muted">{f.note ?? '—'}</td>
              <td className="td">
                {f.status === 'PENDING' ? <Button variant="secondary" className="!py-1" onClick={() => complete(f.id)}>Done</Button> : null}
              </td>
            </tr>
          ))}
        </Table>
        {data && data.items.length === 0 && <EmptyState title="No follow-ups here" subtitle="Schedule a follow-up to stay on top of outreach." />}
        {data && <Pagination page={params.page} total={data.total} pageSize={params.pageSize} onChange={(page) => setParams((p) => ({ ...p, page }))} />}
      </div>
    </div>
  );
}
