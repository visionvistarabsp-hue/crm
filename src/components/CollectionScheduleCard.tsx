'use client';

import { useState } from 'react';
import { useApi, fetcher } from '@/lib/fetcher';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Spinner } from '@/components/ui';
import { formatDate, inr } from '@/lib/utils';

type Milestone = {
  id: string; seq: number; name: string; dueDate: string;
  amount: string; status: string; paidAmount: string;
  outstanding: number; daysUntilDue: number; overdue: boolean; notes: string | null;
};
type Schedule = {
  bookingId: string; bookingNo: string; saleValue: string;
  totalPlanned: number; totalReceived: number; totalOutstanding: number;
  unallocated: number; nextDue: { name: string; dueDate: string; amount: number } | null;
  overdueCount: number; milestones: Milestone[];
};

const STATUS_TONE: Record<string, string> = {
  PENDING: 'bg-clay-dark text-ink-muted',
  PARTIAL: 'bg-amber-100 text-amber-800',
  PAID: 'bg-emerald-100 text-emerald-800',
  WAIVED: 'bg-neutral-200 text-neutral-600',
};

const label = (s: string) => s.toLowerCase();

/** Instalment plan for one booking, with a quick way to build the plan. */
export default function CollectionScheduleCard({ bookingId }: { bookingId: string }) {
  const { data, error, loading, reload } = useApi<Schedule>(
    `/api/collections/schedule?bookingId=${encodeURIComponent(bookingId)}`,
    { deps: [bookingId] },
  );
  const [planning, setPlanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [rows, setRows] = useState([
    { name: 'Booking amount', dueDate: '' },
    { name: 'Agreement registration', dueDate: '' },
    { name: 'Possession', dueDate: '' },
  ]);

  const savePlan = async () => {
    const filled = rows.filter((r) => r.name.trim() && r.dueDate);
    if (filled.length === 0) {
      setPlanError('Fill in a name and due date for at least one instalment.');
      return;
    }
    setBusy(true);
    setPlanError(null);
    try {
      await fetcher('/api/collections', {
        method: 'POST',
        body: JSON.stringify({
          bookingId,
          milestones: filled.map((r, i) => ({
            name: r.name.trim(),
            dueDate: r.dueDate,
            percentage: i === 0 ? '20' : i === 1 ? '30' : '50',
          })),
        }),
      });
      setPlanning(false);
      reload();
    } catch (e) {
      setPlanError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (loading && !data) {
    return (
      <Card>
        <CardHeader title="Payment schedule" />
        <div className="flex justify-center py-6"><Spinner /></div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader title="Payment schedule" />
        <p className="text-sm text-ink-faint">{error.message}</p>
      </Card>
    );
  }

  const hasPlan = (data?.milestones.length ?? 0) > 0;

  return (
    <Card>
      <CardHeader
        title="Payment schedule"
        subtitle={hasPlan ? 'Instalments against the sale value' : 'No instalment plan yet'}
        action={
          <Button variant="secondary" onClick={() => setPlanning((v) => !v)}>
            {hasPlan ? 'Replace plan' : 'Set up plan'}
          </Button>
        }
      />

      {hasPlan && data && (
        <>
          <div className="mb-4 grid grid-cols-3 gap-3">
            <Sum label="Planned" value={inr(data.totalPlanned, true)} />
            <Sum label="Received" value={inr(data.totalReceived, true)} tone="text-emerald-600" />
            <Sum
              label="Outstanding"
              value={inr(data.totalOutstanding, true)}
              tone={data.totalOutstanding > 0 ? 'text-rose-600' : undefined}
            />
          </div>

          {data.overdueCount > 0 && (
            <p className="mb-3 rounded-xl bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">
              {data.overdueCount} {data.overdueCount === 1 ? 'instalment is' : 'instalments are'} overdue.
              {data.nextDue && ` Next due: ${data.nextDue.name} on ${formatDate(data.nextDue.dueDate)}.`}
            </p>
          )}
          {data.unallocated > 0 && (
            <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
              {inr(data.unallocated)} received has no instalment to sit against.
            </p>
          )}

          <div className="space-y-2">
            {data.milestones.map((m) => (
              <div
                key={m.id}
                className={`rounded-2xl bg-clay-deep p-3 shadow-clay-inset-sm ${m.overdue ? 'ring-1 ring-rose-300' : ''}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink">{m.name}</p>
                    <p className={`text-xs ${m.overdue ? 'font-semibold text-rose-600' : 'text-ink-faint'}`}>
                      Due {formatDate(m.dueDate)}
                      {m.overdue ? ` · ${Math.abs(m.daysUntilDue)}d late` : ''}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm font-bold tabular-nums text-ink">{inr(m.amount)}</p>
                    <Badge tone={STATUS_TONE[m.status] === 'bg-emerald-100' ? 'green' : 'gray'}>
                      {label(m.status)}
                    </Badge>
                  </div>
                </div>
                {m.status === 'PARTIAL' && (
                  <p className="mt-1.5 text-xs text-ink-muted">
                    {inr(m.paidAmount)} received · {inr(m.outstanding)} still due
                  </p>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {!hasPlan && !planning && (
        <EmptyState
          title="No instalment plan"
          subtitle="Set one up so collections can chase what is due, and when."
        />
      )}

      {planning && (
        <div className="mt-2 space-y-3 rounded-2xl bg-clay-deep p-4 shadow-clay-inset-sm">
          <p className="text-xs text-ink-muted">
            Percentages are applied to the sale value and spread across the instalments you list.
          </p>
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-2 gap-2">
              <Field label="Instalment">
                <Input
                  value={r.name}
                  onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                />
              </Field>
              <Field label="Due date">
                <Input
                  type="date"
                  value={r.dueDate}
                  onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, dueDate: e.target.value } : x)))}
                />
              </Field>
            </div>
          ))}
          <div className="flex gap-2">
            {rows.length < 6 && (
              <Button
                variant="secondary"
                onClick={() => setRows((rs) => [...rs, { name: '', dueDate: '' }])}
              >
                Add instalment
              </Button>
            )}
            <Button onClick={savePlan} loading={busy} className="ml-auto">Save plan</Button>
          </div>
          {planError && <p className="text-xs font-semibold text-rose-600">{planError}</p>}
        </div>
      )}
    </Card>
  );
}

function Sum({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl bg-clay-deep px-3 py-2 shadow-clay-inset-sm">
      <p className="text-[11px] font-bold uppercase tracking-wider text-ink-faint">{label}</p>
      <p className={`mt-0.5 text-sm font-bold tabular-nums ${tone ?? 'text-ink'}`}>{value}</p>
    </div>
  );
}
