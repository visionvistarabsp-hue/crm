'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { BadgeIndianRupee, Check } from 'lucide-react';
import { Button, Card, CardHeader, EmptyState, Field, Input, PageHeader, Select, Spinner } from '@/components/ui';
import { ApiErrorView, fetcher, useApi } from '@/lib/fetcher';
import { PAYMENT_METHODS } from '@/lib/constants';

type Due = {
  id: string;
  customerId: string | null;
  customerName: string;
  amount: number;
  paidAmount: number;
  outstanding: number;
  dueDate: string;
  status: string;
};

type Result = { receiptNo: string | null; dueId: string | null; outstandingAfter: number; dueSettled: boolean };

type PaymentMethod = (typeof PAYMENT_METHODS)[number];

const METHODS: Array<{ value: PaymentMethod; label: string }> = [
  { value: 'UPI', label: 'UPI' },
  { value: 'CASH', label: 'Cash' },
  { value: 'BANK_TRANSFER', label: 'Bank transfer' },
  { value: 'NEFT', label: 'NEFT' },
  { value: 'RTGS', label: 'RTGS' },
  { value: 'CHEQUE', label: 'Cheque' },
  { value: 'CARD', label: 'Card' },
];

export default function NewPaymentPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-10"><Spinner /></div>}>
      <NewPayment />
    </Suspense>
  );
}

function NewPayment() {
  const params = useSearchParams();
  const preselect = params.get('dueId');

  const { data, error, loading, reload } = useApi<{ items: Due[] }>('/api/easy/payment');
  const [dueId, setDueId] = useState(preselect ?? '');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('UPI');
  const [reference, setReference] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState<Result | null>(null);

  const selected = data?.items.find((d) => d.id === dueId) ?? null;

  useEffect(() => {
    if (selected && !amount) setAmount(String(selected.outstanding));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dueId, data]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const value = Number(amount);
    if (!value || value <= 0) return setFormError('Enter an amount greater than 0');
    if (!dueId) return setFormError('Pick the payment you are collecting against');

    setSaving(true);
    try {
      const res = await fetcher<Result>('/api/easy/payment', {
        method: 'POST',
        body: JSON.stringify({ dueId, amount: value, method, reference: reference.trim() || undefined }),
      });
      setDone(res);
      setAmount('');
      setReference('');
      await reload();
    } catch (e2) {
      setFormError((e2 as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (done) {
    return (
      <div className="mx-auto max-w-lg">
        <PageHeader title="Collected" subtitle="The payment is saved and the receipt is ready" />
        <Card>
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-accent-300 text-primary-900 shadow-clay-sm">
              <Check size={30} />
            </span>
            {done.dueSettled ? (
              <p className="text-sm font-semibold text-ink">That due is now fully settled.</p>
            ) : (
              <p className="text-sm text-ink-muted">
                {done.outstandingAfter.toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })} still
                outstanding on this due.
              </p>
            )}
            {done.receiptNo && <p className="text-xs font-medium text-ink-faint">Receipt {done.receiptNo}</p>}
            <Button
              className="mt-2"
              onClick={() => {
                setDone(null);
                setDueId('');
              }}
            >
              Collect another
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg">
      <PageHeader title="Collect" subtitle="Pick a pending payment and record what you received" />

      <ApiErrorView error={error} onRetry={reload} />
      {loading && !data && (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      )}

      {data && data.items.length === 0 && (
        <EmptyState title="Nothing pending" subtitle="You have no open payment dues to collect against." />
      )}

      <Card>
        <form className="space-y-4" onSubmit={submit}>
          <Field label="Payment to collect" hint="Only dues you own are listed">
            <Select value={dueId} onChange={(e) => setDueId(e.target.value)}>
              <option value="">Choose a payment…</option>
              {data?.items.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.customerName} — ₹{d.outstanding.toLocaleString('en-IN')} ({d.status})
                </option>
              ))}
            </Select>
          </Field>

          {selected && (
            <div className="rounded-2xl bg-clay-deep px-4 py-3 shadow-clay-inset-sm">
              <p className="text-[11px] font-bold uppercase tracking-wide text-ink-faint">Outstanding</p>
              <p className="text-xl font-black text-ink">
                ₹{selected.outstanding.toLocaleString('en-IN')}
                <span className="ml-2 text-xs font-semibold text-ink-faint">of ₹{selected.amount.toLocaleString('en-IN')}</span>
              </p>
            </div>
          )}

          <Field label="Amount received">
            <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0" />
          </Field>

          <Field label="How did they pay?">
            <Select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
              {METHODS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Reference" hint="UPI ref, cheque number — optional">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Optional" />
          </Field>

          {formError && (
            <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700" role="alert">
              {formError}
            </p>
          )}

          <Button type="submit" loading={saving} disabled={!dueId} className="w-full !py-3 text-base">
            <BadgeIndianRupee size={18} /> Record payment
          </Button>
        </form>
      </Card>
    </div>
  );
}
