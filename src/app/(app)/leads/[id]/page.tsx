'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useApi } from '@/lib/useApi';
import { ApiErrorView, fetcher } from '@/lib/fetcher';
import { Badge, Button, Card, CardHeader, EmptyState, Input, Menu, Select, Spinner, StatusBadge, Textarea } from '@/components/ui';
import LeadAiPanel from '@/components/LeadAiPanel';
import LeadOperations from '@/components/LeadOperations';
import { LEAD_STATUSES } from '@/lib/constants';

type LeadDetail = {
  id: string; leadNo: string; name: string; phone: string; whatsapp: string; email: string;
  source: string; campaign: string | null; adName: string | null; budget: string | null;
  preferredLocation: string | null; propertyType: string | null; requirement: string | null;
  priority: string; status: string; tags: string[] | null; notes: string | null;
  ownerId: string | null; ownerName: string | null; projectName: string | null;
  isDuplicate: boolean; duplicateOfId: string | null; createdAt: string;
  activities?: unknown[];
};

export default function LeadDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id as string;
  const { data: lead, error, loading, reload } = useApi<LeadDetail>(`/api/leads/${id}`, { deps: [id] });
  const [busy, setBusy] = useState(false);
  const [newStatus, setNewStatus] = useState('');
  const [assignUser, setAssignUser] = useState('');

  const isDuplicateBanner = lead?.isDuplicate ? (
    <div className="card mb-4 flex items-center justify-between border-amber-200 bg-amber-50 p-4">
      <p className="text-sm text-amber-800">This lead is marked as a duplicate.</p>
      <Button variant="secondary" onClick={async () => { await fetcher('/api/leads/duplicates', { method: 'POST', body: JSON.stringify({ leadId: id, duplicateOfId: lead.duplicateOfId, resolution: 'NOT_DUPLICATE' }) }); reload(); }}>
        Mark as not duplicate
      </Button>
    </div>
  ) : null;

  if (loading && !lead) return <div className="flex justify-center p-10"><Spinner /></div>;
  if (error && !lead) return <ApiErrorView error={error} onRetry={reload} />;
  if (!lead) return <EmptyState title="Lead not found" />;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await reload();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Link href="/leads" className="text-sm text-ink-muted hover:underline">← Leads</Link>
          </div>
          <h1 className="mt-1 text-2xl font-bold">{lead.name}</h1>
          <p className="text-sm text-ink-muted">
            {lead.leadNo} · {lead.source} · {lead.ownerName ?? 'Unassigned'} · created {new Date(lead.createdAt).toLocaleDateString('en-IN')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={lead.status} />
          <Badge tone={lead.priority === 'URGENT' ? 'red' : lead.priority === 'HIGH' ? 'amber' : 'gray'}>{lead.priority}</Badge>
          <Menu
            items={[
              { key: 'complete', label: 'Mark deal completed', onClick: () => act(() => changeStatus('DEAL_COMPLETED')) },
              { key: 'not_interested', label: 'Mark not interested', onClick: () => act(() => changeStatus('NOT_INTERESTED')) },
              { key: 'delete', label: 'Delete lead', danger: true, onClick: () => act(() => del()) },
            ]}
          />
        </div>
      </div>

      {isDuplicateBanner}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Details" action={<Link href="#" className="text-sm text-primary-700">Edit</Link>} />
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
              <Detail label="Phone" value={lead.phone ?? '—'} />
              <Detail label="WhatsApp" value={lead.whatsapp ?? '—'} />
              <Detail label="Email" value={lead.email ?? '—'} />
              <Detail label="Budget" value={lead.budget ? `₹ ${Number(lead.budget).toLocaleString('en-IN')}` : '—'} />
              <Detail label="Preferred location" value={lead.preferredLocation ?? '—'} />
              <Detail label="Property type" value={lead.propertyType ?? '—'} />
              <Detail label="Campaign" value={lead.campaign ?? '—'} />
              <Detail label="Ad name" value={lead.adName ?? '—'} />
              <Detail label="Priority" value={lead.priority} />
            </dl>
            {lead.requirement && <p className="mt-4 text-sm text-ink">{lead.requirement}</p>}
            {lead.notes && <p className="mt-2 text-sm text-ink-muted">{lead.notes}</p>}
            {lead.tags?.length ? <div className="mt-3 flex gap-1.5">{lead.tags.map((t) => <Badge key={t}>{t}</Badge>)}</div> : null}
          </Card>

          <LeadOperations leadId={id} />
        </div>

        <div className="space-y-6">
          <LeadAiPanel leadId={id} />

          <Card>
            <CardHeader title="Change status" />
            <div className="space-y-3">
              <Select value={newStatus} onChange={(e) => setNewStatus(e.target.value)}>
                <option value="">Select status…</option>
                {LEAD_STATUSES.filter((s) => s !== lead.status).map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
              </Select>
              <Button className="w-full" disabled={!newStatus || busy} onClick={() => act(() => changeStatus(newStatus))}>
                Apply status
              </Button>
            </div>
          </Card>

          <Card>
            <CardHeader title="Assignee" subtitle={`Currently: ${lead.ownerName ?? 'unassigned'}`} />
            <div className="space-y-3">
              <Input placeholder="User ID" value={assignUser} onChange={(e) => setAssignUser(e.target.value)} />
              <Button className="w-full" disabled={!assignUser || busy} onClick={() => act(() => fetcher(`/api/leads/${id}/assign`, { method: 'POST', body: JSON.stringify({ userId: assignUser }) }))}>
                Assign
              </Button>
            </div>
          </Card>

          <Card>
            <CardHeader title="Linked" />
            <div className="space-y-1.5 text-sm">
              <Link href={`/leads?status=OPEN`} className="flex justify-between text-ink-muted hover:text-primary-700"><span>Next follow-up</span><span>{'—'}</span></Link>
              <Link href={`/customers`} className="flex justify-between text-ink-muted hover:text-primary-700"><span>Customer record</span><span>{'—'}</span></Link>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );

  async function changeStatus(status: string) {
    await fetcher(`/api/leads/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) });
    setNewStatus('');
  }
  async function del() {
    if (!confirm('Delete this lead permanently?')) return;
    await fetcher(`/api/leads/${id}`, { method: 'DELETE' });
    router.push('/leads');
  }
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-faint">{label}</dt>
      <dd className="mt-0.5 text-ink">{value}</dd>
    </div>
  );
}