'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useApi } from '@/lib/useApi';
import { ApiErrorView } from '@/lib/fetcher';
import { Badge, Button, EmptyState, Input, PageHeader, Pagination, Select, Spinner, StatusBadge, Table } from '@/components/ui';
import { LEAD_STATUSES, LEAD_SOURCES, PRIORITIES } from '@/lib/constants';

type LeadRow = {
  id: string; leadNo: string; name: string; phone: string; email: string; source: string;
  status: string; priority: string; ownerName: string | null; projectName: string | null;
  budget: string | null; nextFollowupAt: string | null; createdAt: string;
};

export default function LeadsPage() {
  const [params, setParams] = useState({ page: 1, pageSize: 25, status: '', owner: '', q: '', source: '', priority: '' });
  const url = useMemo(() => {
    const sp = new URLSearchParams({ page: String(params.page), pageSize: String(params.pageSize) });
    if (params.status) sp.set('status', params.status);
    if (params.owner) sp.set('owner', params.owner);
    if (params.q) sp.set('q', params.q);
    if (params.source) sp.set('source', params.source);
    if (params.priority) sp.set('priority', params.priority);
    return `/api/leads?${sp.toString()}`;
  }, [params]);

  const { data, error, loading, reload } = useApi<{ items: LeadRow[]; total: number }>(url, { deps: [params] });

  const patch = (p: Partial<typeof params>) => setParams((prev) => ({ ...prev, ...p, page: 1 }));

  return (
    <div>
      <PageHeader
        title="Leads"
        subtitle={`${data?.total?.toLocaleString('en-IN') ?? '…'} total`}
        action={
          <>
            <Button variant="secondary" onClick={() => { window.location.href = '/api/export/leads' + (params.q ? `?q=${encodeURIComponent(params.q)}` : ''); }}>
              Export
            </Button>
            <Link href="/leads/new" className="btn-primary">New lead</Link>
          </>
        }
      />

      <div className="card mb-4 grid grid-cols-2 gap-3 p-4 lg:grid-cols-6">
        <Input aria-label="Search leads" placeholder="Search name, phone, email…" value={params.q} onChange={(e) => patch({ q: e.target.value })} />
        <Select aria-label="Filter by status" value={params.status} onChange={(e) => patch({ status: e.target.value })}>
          <option value="">All statuses</option>
          <option value="OPEN">Open</option>
          <option value="CLOSED">Closed</option>
          {LEAD_STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
        </Select>
        <Select aria-label="Filter by owner" value={params.owner} onChange={(e) => patch({ owner: e.target.value })}>
          <option value="">All owners</option>
          <option value="mine">Mine</option>
          <option value="unassigned">Unassigned</option>
        </Select>
        <Select aria-label="Filter by source" value={params.source} onChange={(e) => patch({ source: e.target.value })}>
          <option value="">All sources</option>
          {LEAD_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
        </Select>
        <Select aria-label="Filter by priority" value={params.priority} onChange={(e) => patch({ priority: e.target.value })}>
          <option value="">All priorities</option>
          {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </Select>
        <Button variant="secondary" onClick={() => setParams({ page: 1, pageSize: 25, status: '', owner: '', q: '', source: '', priority: '' })}>
          Reset
        </Button>
      </div>

      {loading && !data && <div className="flex justify-center p-10"><Spinner /></div>}
      <ApiErrorView error={error} onRetry={reload} />

      <div className="card">
        <Table head={['Lead', 'Contact', 'Source', 'Status', 'Priority', 'Owner', 'Next follow-up', 'Created']}>
          {data?.items?.map((l) => (
            <tr key={l.id} className="cursor-pointer transition-colors hover:bg-primary-50/50" onClick={() => (window.location.href = `/leads/${l.id}`)}>
              <td className="td">
                <p className="font-medium text-ink">{l.name}</p>
                <p className="text-xs text-ink-faint">{l.leadNo}</p>
              </td>
              <td className="td">
                <p className="text-ink-muted">{l.phone || '—'}</p>
                <p className="text-xs text-ink-faint">{l.email || ''}</p>
              </td>
              <td className="td"><Badge tone="purple">{l.source}</Badge></td>
              <td className="td"><StatusBadge status={l.status} /></td>
              <td className="td">{l.priority || '—'}</td>
              <td className="td text-ink-muted">{l.ownerName ?? l.projectName ?? '—'}</td>
              <td className="td text-ink-muted">{l.nextFollowupAt ? new Date(l.nextFollowupAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
              <td className="td text-ink-faint">{new Date(l.createdAt).toLocaleDateString('en-IN')}</td>
            </tr>
          ))}
        </Table>
        {data && data.items.length === 0 && <EmptyState title="No leads match" subtitle="Try adjusting the filters or create a new lead." />}
        {data && <Pagination page={params.page} total={data.total} pageSize={params.pageSize} onChange={(page) => setParams((p) => ({ ...p, page }))} />}
      </div>
    </div>
  );
}