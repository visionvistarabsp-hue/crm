'use client';

import { useMemo, useState } from 'react';
import { useApi } from '@/lib/useApi';
import { ApiErrorView, fetcher } from '@/lib/fetcher';
import { Badge, Button, Card, CardHeader, EmptyState, Input, Spinner, Stat, StatusBadge } from '@/components/ui';

type LeadOpsKind =
  | 'FOLLOWUP'
  | 'SITE_VISIT'
  | 'MEETING'
  | 'BOOKING'
  | 'PAYMENT'
  | 'DOCUMENT'
  | 'STATUS_CHANGE'
  | 'NOTE'
  | 'MESSAGE'
  | 'ACTIVITY';

type TimelineEntry = {
  id: string;
  kind: LeadOpsKind;
  title: string;
  detail: string | null;
  at: string;
  amount: number | null;
  status: string | null;
  refId: string;
  actorName: string | null;
};

type OperationsView = {
  lead: { id: string; leadNo: string; name: string; status: string };
  summary: {
    nextFollowup: { id: string; scheduledAt: string; status: string } | null;
    overdueCount: number;
    visits: { completed: number; nextScheduledAt: string | null };
    booking: { id: string; bookingNo: string; status: string } | null;
    agreement: { id: string; title: string | null; fileName: string; verificationStatus: string } | null;
    amountCollected: number;
  };
  timeline: TimelineEntry[];
};

const KINDS: Array<LeadOpsKind | 'ALL'> = [
  'ALL', 'FOLLOWUP', 'SITE_VISIT', 'MEETING', 'BOOKING', 'PAYMENT',
  'DOCUMENT', 'STATUS_CHANGE', 'NOTE', 'MESSAGE', 'ACTIVITY',
];

const KIND_LABEL: Record<LeadOpsKind, string> = {
  FOLLOWUP: 'Follow-up',
  SITE_VISIT: 'Visit',
  MEETING: 'Meeting',
  BOOKING: 'Booking',
  PAYMENT: 'Payment',
  DOCUMENT: 'Document',
  STATUS_CHANGE: 'Status',
  NOTE: 'Note',
  MESSAGE: 'Message',
  ACTIVITY: 'Activity',
};

const KIND_TONE: Record<LeadOpsKind, 'blue' | 'green' | 'amber' | 'gray' | 'purple'> = {
  FOLLOWUP: 'blue',
  SITE_VISIT: 'blue',
  MEETING: 'blue',
  BOOKING: 'blue',
  PAYMENT: 'green',
  DOCUMENT: 'amber',
  STATUS_CHANGE: 'purple',
  NOTE: 'gray',
  MESSAGE: 'blue',
  ACTIVITY: 'gray',
};

const rupee = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

function when(iso: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

export default function LeadOperations({ leadId }: { leadId: string }) {
  const { data, error, loading, reload } = useApi<OperationsView>(`/api/leads/${leadId}/operations`, { deps: [leadId] });
  const [kind, setKind] = useState<LeadOpsKind | 'ALL'>('ALL');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const timeline = useMemo(
    () => (data?.timeline ?? []).filter((e) => kind === 'ALL' || e.kind === kind),
    [data, kind],
  );

  if (loading && !data) return <div className="flex justify-center p-10"><Spinner /></div>;
  if (error && !data) return <ApiErrorView error={error} onRetry={reload} />;
  if (!data) return <EmptyState title="No operations data" />;

  const s = data.summary;

  return (
    <div>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat
          label="Next follow-up"
          value={s.nextFollowup ? new Date(s.nextFollowup.scheduledAt).toLocaleDateString('en-IN') : '—'}
          hint={s.nextFollowup ? new Date(s.nextFollowup.scheduledAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : undefined}
          tone={s.overdueCount > 0 ? 'amber' : undefined}
        />
        <Stat label="Overdue" value={String(s.overdueCount)} tone={s.overdueCount > 0 ? 'red' : undefined} />
        <Stat
          label="Site visits"
          value={`${s.visits.completed} completed`}
          hint={s.visits.nextScheduledAt ? `Next ${when(s.visits.nextScheduledAt)}` : undefined}
        />
        <Stat label="Latest booking" value={s.booking?.bookingNo ?? '—'} hint={s.booking?.status?.replace(/_/g, ' ') ?? undefined} />
        <Stat label="Agreement" value={s.agreement?.verificationStatus?.replace(/_/g, ' ') ?? '—'} />
      </div>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Collected" value={rupee.format(s.amountCollected)} />
      </div>

      <Card>
        <CardHeader title="Operations" subtitle={`${timeline.length} event${timeline.length === 1 ? '' : 's'}`} />
        <form
          className="flex items-start gap-2 border-b border-line px-4 py-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!note.trim()) return;
            setBusy(true);
            try {
              await fetcher(`/api/leads/${leadId}/activities`, { method: 'POST', body: JSON.stringify({ type: 'NOTE', note }) });
              setNote('');
              await reload();
            } catch (err) {
              alert((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Input className="flex-1" placeholder="Add a note…" value={note} onChange={(e) => setNote(e.target.value)} />
          <Button type="submit" disabled={busy}>Add</Button>
        </form>
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
              {k === 'ALL' ? 'All' : KIND_LABEL[k]}
            </button>
          ))}
        </div>

        {timeline.length === 0 ? (
          <EmptyState title="Nothing here yet" subtitle="Follow-ups, visits, bookings, payments and notes will appear here." />
        ) : (
          <ol className="divide-y divide-line">
            {timeline.map((e) => (
              <li key={e.id} className="flex items-start gap-3 px-4 py-3">
                <Badge tone={KIND_TONE[e.kind]} className="mt-0.5 shrink-0">{KIND_LABEL[e.kind]}</Badge>
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
  );
}