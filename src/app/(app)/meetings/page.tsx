'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useApi } from '@/lib/useApi';
import { ApiErrorView } from '@/lib/fetcher';
import { Badge, EmptyState, PageHeader, Pagination, Select, Spinner, StatusBadge, Table } from '@/components/ui';
import { MEETING_TYPES } from '@/lib/constants';

type Meeting = {
  id: string; type: string; title: string; scheduledAt: string; status: string;
  leadName?: string | null; projectName?: string | null; unitNo?: string | null; assigneeName?: string | null;
};

export default function MeetingsPage() {
  const [params, setParams] = useState({ page: 1, pageSize: 25, type: 'ALL', status: '' });
  const url = useMemo(() => {
    const sp = new URLSearchParams({ page: String(params.page), pageSize: String(params.pageSize), type: params.type });
    if (params.status) sp.set('status', params.status);
    return `/api/meetings?${sp.toString()}`;
  }, [params]);
  const { data, error, loading } = useApi<{ items: Meeting[]; total: number }>(url, { deps: [params] });

  return (
    <div>
      <PageHeader title="Meetings & visits" subtitle="Site visits and internal meetings" action={<Link href="/meetings/new" className="btn-primary">Schedule</Link>} />
      <div className="mb-4 flex flex-wrap gap-2">
        <Select aria-label="Filter by type" className="!w-auto" value={params.type} onChange={(e) => setParams((p) => ({ ...p, type: e.target.value, page: 1 }))}>
          <option value="ALL">All types</option>
          {MEETING_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
        </Select>
        <Select aria-label="Filter by status" className="!w-auto" value={params.status} onChange={(e) => setParams((p) => ({ ...p, status: e.target.value, page: 1 }))}>
          <option value="">All statuses</option>
          {['SCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'].map((s) => <option key={s} value={s}>{s}</option>)}
        </Select>
      </div>

      {loading && !data && <div className="flex justify-center p-10"><Spinner /></div>}
      <ApiErrorView error={error} onRetry={() => setParams((p) => ({ ...p }))} />

      <div className="card">
        <Table head={['Meeting', 'Type', 'Scheduled', 'Status', 'Lead', 'Unit']}>
          {data?.items?.map((m) => (
            <tr key={m.id}>
              <td className="td">
                <p className="font-medium text-ink">{m.title}</p>
                <p className="text-xs text-ink-faint">{m.assigneeName ?? ''}</p>
              </td>
              <td className="td"><Badge tone={m.type === 'SITE_VISIT' ? 'green' : 'purple'}>{m.type.replace(/_/g, ' ')}</Badge></td>
              <td className="td tabular-nums">{new Date(m.scheduledAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
              <td className="td"><StatusBadge status={m.status} /></td>
              <td className="td text-ink-muted">{m.leadName ?? '—'}</td>
              <td className="td text-ink-muted">{m.unitNo ?? '—'}</td>
            </tr>
          ))}
        </Table>
        {data && data.items.length === 0 && <EmptyState title="No meetings scheduled" />}
        {data && <Pagination page={params.page} total={data.total} pageSize={params.pageSize} onChange={(page) => setParams((p) => ({ ...p, page }))} />}
      </div>
    </div>
  );
}
