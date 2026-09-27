'use client';

import { useState } from 'react';
import { useApi, fetcher } from '@/lib/fetcher';
import {
  Button, Card, CardHeader, EmptyState, Input, PageHeader, Select, Spinner, Stat, Table,
} from '@/components/ui';
import { formatDate, inr } from '@/lib/utils';
import { PAYMENT_METHODS } from '@/lib/constants';

type Aging = { key: string; label: string; count: number; amount: number };
type Overdue = {
  milestoneId: string; bookingId: string; bookingNo: string; customerName: string;
  projectName: string; salespersonName: string | null; name: string;
  dueDate: string; amount: number; paidAmount: number; outstanding: number; daysOverdue: number;
};
type Report = {
  totalOutstanding: number;
  totalOverdue: number;
  overdueCount: number;
  buckets: Aging[];
  overdue: Overdue[];
};

const BUCKET_TONE: Record<string, string> = {
  current: 'text-ink-muted',
  d1_30: 'text-amber-600',
  d31_60: 'text-orange-600',
  d61_90: 'text-rose-500',
  d90plus: 'text-rose-700',
};

const toneFor = (days: number) =>
  days <= 30 ? 'd1_30' : days <= 60 ? 'd31_60' : days <= 90 ? 'd61_90' : 'd90plus';

type Target = Overdue | null;

export default function CollectionsPage() {
  const { data, error, loading, reload } = useApi<Report>('/api/collections');
  const [target, setTarget] = useState<Target>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<string>(PAYMENT_METHODS[0]);
  const [reference, setReference] = useState('');
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const openRecord = (row: Overdue) => {
    setTarget(row);
    // Default to the full outstanding balance, which is the common case.
    setAmount(String(row.outstanding));
    setMethod(PAYMENT_METHODS[0]);
    setReference('');
    setActionError(null);
  };

  const submit = async () => {
    if (!target) return;
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setActionError('Enter an amount greater than zero.');
      return;
    }
    if (value > target.outstanding) {
      setActionError(`That is more than the ${inr(target.outstanding)} outstanding.`);
      return;
    }
    setSaving(true);
    setActionError(null);
    try {
      const res = await fetcher<{ paymentId: string; receiptNo: string | null }>(
        '/api/collections/payment',
        {
          method: 'POST',
          body: JSON.stringify({
            bookingId: target.bookingId,
            milestoneId: target.milestoneId,
            amount: value,
            method,
            reference: reference.trim() || null,
            autoAllocate: false,
          }),
        },
      );
      setTarget(null);
      reload();
      // The receipt is issued in the same call; hand the user straight to it.
      if (res.receiptNo) {
        window.open(`/receipts/${res.paymentId}`, '_blank', 'noopener');
      }
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loading && !data) return <div className="flex justify-center p-10"><Spinner /></div>;
  if (error && !data) {
    return (
      <div className="rounded-2xl bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">
        {error.message}
      </div>
    );
  }
  if (!data) return <EmptyState title="No collection data" />;

  return (
    <div>
      <PageHeader
        title="Collections"
        subtitle="What is owed, how late it is, and who to chase"
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Outstanding" value={inr(data.totalOutstanding)} hint="All open milestones" />
        <Stat label="Overdue" value={inr(data.totalOverdue)} hint="Past the due date" />
        <Stat
          label="Overdue count"
          value={String(data.overdueCount)}
          hint={data.overdueCount === 0 ? 'Nothing is late' : 'Instalments past due'}
        />
        <Stat
          label="Oldest bucket"
          value={data.buckets.length ? data.buckets[data.buckets.length - 1].label : '—'}
          hint="Worst ageing band"
        />
      </div>

      {actionError && !target && (
        <div className="mt-4 rounded-2xl bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">
          {actionError}
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader title="Overdue instalments" subtitle="Oldest first" />
            {data.overdue.length === 0 ? (
              <EmptyState
                title="Nothing overdue"
                subtitle="Every milestone is either paid or still within terms"
              />
            ) : (
              <Table head={['Customer', 'Booking', 'Instalment', 'Due', 'Outstanding', 'Overdue', '']}>
                {data.overdue.map((o) => (
                  <tr key={o.milestoneId}>
                    <td className="px-5 py-4">
                      <p className="text-sm font-semibold text-ink">{o.customerName}</p>
                      <p className="text-[11px] text-ink-faint">
                        {o.projectName}
                        {o.salespersonName ? ` · ${o.salespersonName}` : ''}
                      </p>
                    </td>
                    <td className="px-5 py-4 text-sm font-semibold text-ink-muted">{o.bookingNo}</td>
                    <td className="px-5 py-4 text-sm text-ink-muted">{o.name}</td>
                    <td className="px-5 py-4 text-sm text-ink-muted">{formatDate(o.dueDate)}</td>
                    <td className="px-5 py-4 text-sm font-bold tabular-nums text-ink">
                      {inr(o.outstanding)}
                    </td>
                    <td className={`px-5 py-4 text-sm font-bold tabular-nums ${BUCKET_TONE[toneFor(o.daysOverdue)]}`}>
                      {o.daysOverdue}d
                    </td>
                    <td className="px-5 py-4 text-right">
                      <Button variant="secondary" onClick={() => openRecord(o)}>Record</Button>
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </div>

        <div>
          <Card>
            <CardHeader title="Ageing" subtitle="Outstanding by how late it is" />
            <div className="space-y-2">
              {data.buckets.map((b) => (
                <div key={b.key} className="flex items-center justify-between gap-2 text-sm">
                  <span className={`font-semibold ${BUCKET_TONE[b.key] ?? 'text-ink-muted'}`}>{b.label}</span>
                  <span className="shrink-0 text-right">
                    <span className="font-bold tabular-nums text-ink">{inr(b.amount)}</span>
                    <span className="ml-2 text-xs tabular-nums text-ink-faint">{b.count}</span>
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      {target && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-3xl bg-surface p-6 shadow-pop">
            <h2 className="text-lg font-bold text-ink">Record payment</h2>
            <p className="mt-1 text-xs text-ink-muted">
              {target.customerName} · {target.bookingNo} · {target.name}
            </p>

            <div className="mt-4 rounded-2xl bg-clay-deep px-4 py-3 shadow-clay-inset-sm">
              <p className="text-[11px] font-bold uppercase tracking-wider text-ink-faint">Outstanding</p>
              <p className="mt-0.5 text-2xl font-bold tabular-nums text-ink">
                {inr(target.outstanding)}
              </p>
              <p className="text-xs text-ink-faint">Due {formatDate(target.dueDate)}</p>
            </div>

            <label className="mt-4 block text-xs font-bold uppercase tracking-wider text-ink-faint">
              Amount
            </label>
            <Input
              type="number"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="mt-1 text-right"
            />

            <label className="mt-3 block text-xs font-bold uppercase tracking-wider text-ink-faint">
              Method
            </label>
            <Select value={method} onChange={(e) => setMethod(e.target.value)} className="mt-1">
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>{m.replace(/_/g, ' ').toLowerCase()}</option>
              ))}
            </Select>

            <label className="mt-3 block text-xs font-bold uppercase tracking-wider text-ink-faint">
              Reference <span className="font-normal normal-case">(UTR / cheque no.)</span>
            </label>
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Optional"
              className="mt-1"
            />

            {actionError && (
              <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">
                {actionError}
              </p>
            )}

            <p className="mt-4 text-[11px] text-ink-faint">
              A receipt is issued automatically and opens in a new tab so you can print it.
            </p>

            <div className="mt-4 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setTarget(null)}>Cancel</Button>
              <Button onClick={submit} loading={saving}>Record &amp; issue receipt</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
