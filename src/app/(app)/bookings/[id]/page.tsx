'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useApi } from '@/lib/useApi';
import { ApiErrorView, fetcher } from '@/lib/fetcher';
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, Menu, Spinner, StatusBadge } from '@/components/ui';
import CollectionScheduleCard from '@/components/CollectionScheduleCard';
import LoanCard from '@/components/LoanCard';

type BookingDetail = {
  id: string; bookingNo: string; status: string; bookingDate: string; bookingAmount: string | null;
  saleValue: string | null; notes: string | null;
  customer?: { name: string; phone: string; email: string } | null;
  unit?: { unitNo: string; towerName?: string | null } | null;
  project?: { name: string } | null;
  salesperson?: { name: string } | null;
  payments?: Array<{ id: string; amount: string; method: string; status: string; paymentDate: string }>;
  cancellations?: Array<{ id: string; reason: string | null; status: string }>;
};

export default function BookingDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id as string;
  const { data: b, error, loading, reload } = useApi<BookingDetail>(`/api/bookings/${id}`, { deps: [id] });
  const [payOpen, setPayOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  if (loading && !b) return <div className="flex justify-center p-10"><Spinner /></div>;
  if (error && !b) return <ApiErrorView error={error} onRetry={reload} />;
  if (!b) return <EmptyState title="Booking not found" />;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); await reload(); } catch (e) { alert((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/bookings" className="text-sm text-ink-muted hover:underline">← Bookings</Link>
          <div className="mt-1 flex items-center gap-2">
            <h1 className="text-2xl font-bold">{b.bookingNo}</h1>
            <StatusBadge status={b.status} />
          </div>
          <p className="text-sm text-ink-muted">
            {[b.customer?.name, b.project?.name, b.unit?.unitNo, b.salesperson?.name].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => setPayOpen(true)}>Add payment</Button>
          {b.status !== 'CANCELLED' && b.status !== 'CANCELLATION_REQUESTED' && (
            <Button variant="danger" onClick={() => setCancelOpen(true)}>Request cancellation</Button>
          )}
          <Menu items={[{ key: 'reload', label: 'Refresh', onClick: reload }]} />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Payments" action={<Button onClick={() => setPayOpen(true)}>Add payment</Button>} />
            <div className="space-y-2">
              {(b.payments ?? []).map((p) => (
                <div key={p.id} className="flex items-center justify-between rounded-2xl bg-clay-deep p-3 shadow-clay-inset-sm">
                  <div>
                    <p className="text-sm font-medium text-ink">₹ {Number(p.amount).toLocaleString('en-IN')}</p>
                    <p className="text-xs text-ink-faint">{p.method} · {new Date(p.paymentDate).toLocaleDateString('en-IN')}</p>
                  </div>
                  <StatusBadge status={p.status} />
                </div>
              ))}
              {(b.payments ?? []).length === 0 && <p className="text-sm text-ink-faint">No payments recorded.</p>}
            </div>
          </Card>

          <CollectionScheduleCard bookingId={b.id} />

          <LoanCard bookingId={b.id} saleValue={b.saleValue} />

          <Card>
            <CardHeader title="Cancellations" />
            {(b.cancellations ?? []).map((c) => (
              <div key={c.id} className="flex items-center justify-between rounded-2xl bg-clay-deep p-3 shadow-clay-inset-sm">
                <p className="text-sm text-ink">{c.reason ?? 'Cancellation request'}</p>
                <StatusBadge status={c.status} />
              </div>
            ))}
            {(b.cancellations ?? []).length === 0 && <p className="text-sm text-ink-faint">No cancellation requests.</p>}
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Deal summary" />
            <dl className="space-y-2 text-sm">
              <Row label="Sale value" value={b.saleValue ? `₹ ${Number(b.saleValue).toLocaleString('en-IN')}` : '—'} />
              <Row label="Paid at booking" value={b.bookingAmount ? `₹ ${Number(b.bookingAmount).toLocaleString('en-IN')}` : '—'} />
              <Row label="Booking date" value={new Date(b.bookingDate).toLocaleDateString('en-IN')} />
              <Row label="Customer" value={b.customer?.name ?? '—'} />
              <Row label="Project" value={b.project?.name ?? '—'} />
              <Row label="Unit" value={[b.unit?.towerName, b.unit?.unitNo].filter(Boolean).join(' · ') || '—'} />
              {b.notes && <Row label="Notes" value={b.notes} />}
            </dl>
          </Card>
          <Card>
            <CardHeader title="Actions" />
            <div className="space-y-2">
              <Link href={`/leads?q=${encodeURIComponent(b.customer?.name ?? '')}`} className="block rounded-xl bg-surface px-3 py-2 text-center font-semibold shadow-clay-sm text-center text-sm text-ink-muted hover:text-primary-700 hover:shadow-clay">
                View related lead
              </Link>
              <Button variant="danger" className="w-full" onClick={() => setCancelOpen(true)}>Cancel this booking</Button>
            </div>
          </Card>
        </div>
      </div>

      <Dialog open={payOpen} onClose={() => setPayOpen(false)} title="Add payment"
        footer={<><Button variant="secondary" onClick={() => setPayOpen(false)}>Close</Button></>}>
        <PaymentForm bookingId={id} onDone={() => { setPayOpen(false); reload(); }} />
      </Dialog>

      <Dialog open={cancelOpen} onClose={() => setCancelOpen(false)} title="Request cancellation"
        footer={<><Button variant="secondary" onClick={() => setCancelOpen(false)}>Close</Button></>}>
        <CancelForm bookingId={id} onDone={() => { setCancelOpen(false); reload(); }} />
      </Dialog>
    </div>
  );

  function Row({ label, value }: { label: string; value: string }) {
    return (
      <div className="flex justify-between gap-3">
        <dt className="text-ink-faint">{label}</dt>
        <dd className="text-right font-medium text-ink">{value}</dd>
      </div>
    );
  }
}

function PaymentForm({ bookingId, onDone }: { bookingId: string; onDone: () => void }) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('BANK_TRANSFER');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    await fetcher(`/api/bookings/${bookingId}`, { method: 'POST', body: JSON.stringify({ amount: Number(amount), method, paymentDate: new Date().toISOString() }) });
    onDone();
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Amount (₹)"><Input type="number" required value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
      <Field label="Method">
        <select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
          {['CASH', 'CHEQUE', 'BANK_TRANSFER', 'UPI', 'CARD'].map((m) => <option key={m}>{m}</option>)}
        </select>
      </Field>
      <Button type="submit" className="w-full">Record payment</Button>
    </form>
  );
}

function CancelForm({ bookingId, onDone }: { bookingId: string; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [refund, setRefund] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    await fetcher(`/api/bookings/${bookingId}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason, reasonCategory: 'OTHER', refundAmount: refund ? Number(refund) : 0 }),
    });
    onDone();
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Reason"><textarea className="input min-h-[72px]" required value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <Field label="Refund amount (₹)" hint="0 if no refund due"><Input type="number" value={refund} onChange={(e) => setRefund(e.target.value)} /></Field>
      <Button type="submit" className="w-full">Submit request</Button>
    </form>
  );
}