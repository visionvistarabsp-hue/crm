'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useApi } from '@/lib/useApi';
import { ApiErrorView, fetcher } from '@/lib/fetcher';
import { Badge, Button, Card, CardHeader, EmptyState, Spinner, Stat, StatusBadge, Textarea } from '@/components/ui';

type TimelineKind = 'ACTIVITY' | 'BOOKING' | 'PAYMENT' | 'DOCUMENT';

type TimelineEntry = {
  id: string;
  kind: TimelineKind;
  title: string;
  detail: string | null;
  at: string;
  amount: number | null;
  status: string | null;
  refId: string;
  actorName: string | null;
};

type Customer360 = {
  customer: {
    id: string; customerNo: string; name: string; phone: string; whatsapp: string | null;
    email: string | null; pan: string | null; aadhaar: string | null;
    address: string | null; city: string | null; state: string | null; pincode: string | null;
    ownerName: string | null; createdAt: string;
  };
  lead: { id: string; leadNo: string; name: string; status: string; source: string | null } | null;
  projects: Array<{ id: string; name: string; code: string }>;
  summary: {
    bookingCount: number; activeBookings: number; totalSaleValue: number; totalReceived: number;
    totalOutstanding: number; documentCount: number; pendingDocuments: number;
  };
  timeline: TimelineEntry[];
};

const KINDS: Array<TimelineKind | 'ALL'> = ['ALL', 'ACTIVITY', 'BOOKING', 'PAYMENT', 'DOCUMENT'];

const rupee = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

const KIND_TONE: Record<TimelineKind, 'blue' | 'green' | 'amber' | 'gray'> = {
  ACTIVITY: 'gray',
  BOOKING: 'blue',
  PAYMENT: 'green',
  DOCUMENT: 'amber',
};

function when(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

export default function CustomerDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id as string;
  const { data, error, loading, reload } = useApi<Customer360>(`/api/customers/${id}/history`, { deps: [id] });
  const [kind, setKind] = useState<TimelineKind | 'ALL'>('ALL');

  const timeline = useMemo(
    () => (data?.timeline ?? []).filter((e) => kind === 'ALL' || e.kind === kind),
    [data, kind],
  );

  if (loading && !data) return <div className="flex justify-center p-10"><Spinner /></div>;
  if (error && !data) return <ApiErrorView error={error} onRetry={reload} />;
  if (!data) return <EmptyState title="Customer not found" />;

  const c = data.customer;
  const s = data.summary;

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/customers" className="text-sm text-ink-muted hover:underline">← Customers</Link>
          <div className="mt-1 flex items-center gap-2">
            <h1 className="text-xl font-semibold text-ink">{c.name}</h1>
            <Badge tone="gray">{c.customerNo}</Badge>
          </div>
          <p className="text-sm text-ink-muted">
            {[c.phone, c.email].filter(Boolean).join(' · ') || 'No contact details'}
            {c.ownerName ? ` · Owner: ${c.ownerName}` : ''}
          </p>
        </div>
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Bookings" value={s.bookingCount} hint={`${s.activeBookings} active`} />
        <Stat label="Contract value" value={rupee.format(s.totalSaleValue)} />
        <Stat label="Received" value={rupee.format(s.totalReceived)} />
        <Stat label="Outstanding" value={rupee.format(s.totalOutstanding)} tone={s.totalOutstanding > 0 ? 'amber' : undefined} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader title="History" subtitle={`${timeline.length} event${timeline.length === 1 ? '' : 's'}`} />
            <div className="flex flex-wrap gap-1.5 border-b border-line px-4 py-3">
              {KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                    kind === k ? 'bg-primary text-white' : 'bg-surface text-ink-muted hover:bg-line'
                  }`}
                >
                  {k === 'ALL' ? 'All' : k[0] + k.slice(1).toLowerCase()}
                </button>
              ))}
            </div>

            {timeline.length === 0 ? (
              <EmptyState title="Nothing here yet" subtitle="Events appear as bookings, payments, documents and notes are added." />
            ) : (
              <ol className="divide-y divide-line">
                {timeline.map((e) => (
                  <li key={e.id} className="flex items-start gap-3 px-4 py-3">
                    <Badge tone={KIND_TONE[e.kind]} className="mt-0.5 shrink-0">{e.kind}</Badge>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-ink">{e.title}</p>
                      {e.detail && <p className="truncate text-sm text-ink-muted">{e.detail}</p>}
                      <p className="text-xs text-ink-faint">
                        {when(e.at)}
                        {e.actorName ? ` · ${e.actorName}` : ''}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      {e.amount !== null && <p className="font-medium text-ink">{rupee.format(e.amount)}</p>}
                      {e.status && <StatusBadge status={e.status} />}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <AddNote customerId={id} onSaved={reload} />

          <Card>
            <CardHeader title="Contact & KYC" />
            <dl className="space-y-2 px-4 pb-4 text-sm">
              <Row label="Phone" value={c.phone} />
              <Row label="WhatsApp" value={c.whatsapp} />
              <Row label="Email" value={c.email} />
              <Row label="PAN" value={c.pan} />
              <Row label="Aadhaar" value={c.aadhaar} />
              <Row label="Address" value={[c.address, c.city, c.state, c.pincode].filter(Boolean).join(', ')} />
            </dl>
          </Card>

          <Card>
            <CardHeader title="Pipeline" />
            <div className="space-y-3 px-4 pb-4 text-sm">
              {data.lead ? (
                <div>
                  <p className="text-xs uppercase tracking-wide text-ink-faint">From lead</p>
                  <p className="font-medium text-ink">
                    <Link href={`/leads/${data.lead.id}`} className="hover:underline">{data.lead.name}</Link>
                  </p>
                  <p className="text-xs text-ink-muted">
                    {data.lead.leadNo} <StatusBadge status={data.lead.status} />
                    {data.lead.source ? ` · ${data.lead.source}` : ''}
                  </p>
                </div>
              ) : (
                <p className="text-ink-muted">No originating lead.</p>
              )}

              <div>
                <p className="text-xs uppercase tracking-wide text-ink-faint">Projects</p>
                {data.projects.length === 0 ? (
                  <p className="text-ink-muted">None yet.</p>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {data.projects.map((p) => (
                      <li key={p.id} className="text-ink">{p.name} <span className="text-xs text-ink-faint">{p.code}</span></li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2 border-t border-line pt-3 text-sm">
                <div>
                  <p className="text-xs text-ink-faint">Documents</p>
                  <p className="font-medium text-ink">{s.documentCount}</p>
                </div>
                <div>
                  <p className="text-xs text-ink-faint">Pending</p>
                  <p className="font-medium text-ink">{s.pendingDocuments}</p>
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="shrink-0 text-ink-faint">{label}</dt>
      <dd className="text-right text-ink">{value || '—'}</dd>
    </div>
  );
}

function AddNote({ customerId, onSaved }: { customerId: string; onSaved: () => void | Promise<void> }) {
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!note.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await fetcher(`/api/customers/${customerId}/history`, { method: 'POST', body: JSON.stringify({ note }) });
      setNote('');
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Add note" subtitle="Visible to everyone who can see this customer" />
      <form onSubmit={submit} className="space-y-3 px-4 pb-4">
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          maxLength={2000}
          placeholder="Called about payment schedule…"
        />
        {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <Button type="submit" loading={saving} disabled={!note.trim()}>Save note</Button>
      </form>
    </Card>
  );
}
