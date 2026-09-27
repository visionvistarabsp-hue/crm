'use client';

import { useState } from 'react';
import { useApi } from '@/lib/useApi';
import { ApiErrorView, fetcher } from '@/lib/fetcher';
import { Button, Card, CardHeader, Dialog, EmptyState, Field, Input, PageHeader, Spinner, StatusBadge, Table } from '@/components/ui';

type Batch = {
  id: string; name: string; status: string; totalAmount: string | null; paymentMonth: string | null;
  createdById: string | null; createdAt: string;
  transactions?: Array<{ id: string; personId: string | null; personName?: string | null; amount: string | null; status: string }>;
};

export default function PayoutsPage() {
  const { data, error, loading, reload } = useApi<{ items: Batch[] }>('/api/payouts');
  const dash = useApi<{ } | null>('/api/payouts/dashboard');
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const act = async (id: string, action: 'process' | 'finalize') => {
    setBusyId(id);
    try { await fetcher(`/api/payouts/${id}`, { method: 'POST', body: JSON.stringify({ action }) }); await reload(); }
    catch (e) { alert((e as Error).message); }
    finally { setBusyId(null); }
  };

  return (
    <div>
      <PageHeader title="Payouts" subtitle="Commission payout batches"
        action={<Button onClick={() => setOpen(true)}>New batch</Button>} />

      {loading && !data && <div className="flex justify-center p-10"><Spinner /></div>}
      <ApiErrorView error={error} onRetry={reload} />

      <div className="space-y-5">
        {data?.items?.map((b) => (
          <Card key={b.id}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-semibold">{b.name}</h3>
                  <StatusBadge status={b.status} />
                </div>
                <p className="text-sm text-ink-muted">{b.paymentMonth ?? '—'} · created {new Date(b.createdAt).toLocaleDateString('en-IN')}</p>
              </div>
              <div className="flex items-center gap-2">
                <p className="mr-2 text-lg font-bold tabular-nums">
                  {b.totalAmount ? `₹ ${Number(b.totalAmount).toLocaleString('en-IN')}` : '—'}
                </p>
                {b.status === 'DRAFT' && (
                  <Button disabled={busyId === b.id} loading={busyId === b.id} onClick={() => act(b.id, 'process')}>Process</Button>
                )}
                {b.status === 'PROCESSED' && (
                  <Button disabled={busyId === b.id} loading={busyId === b.id} onClick={() => act(b.id, 'finalize')}>Finalize</Button>
                )}
              </div>
            </div>

            {b.transactions && b.transactions.length > 0 && (
              <div className="mt-4">
                <Table head={['Person', 'Amount', 'Status']}>
                  {b.transactions.map((t) => (
                    <tr key={t.id}>
                      <td className="td text-ink">{t.personName ?? t.personId ?? '—'}</td>
                      <td className="td tabular-nums">{t.amount ? `₹ ${Number(t.amount).toLocaleString('en-IN')}` : '—'}</td>
                      <td className="td"><StatusBadge status={t.status} /></td>
                    </tr>
                  ))}
                </Table>
              </div>
            )}
          </Card>
        ))}
        {data && data.items.length === 0 && <EmptyState title="No payout batches" action={<Button onClick={() => setOpen(true)}>Create first batch</Button>} />}
      </div>

      <BatchDialog open={open} onClose={() => setOpen(false)} onDone={() => { setOpen(false); reload(); dash.reload(); }} />
    </div>
  );
}

function BatchDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ name: '', paymentMonth: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try { await fetcher('/api/payouts', { method: 'POST', body: JSON.stringify({ name: form.name, paymentMonth: form.paymentMonth || null }) }); onDone(); }
    catch (err) { setError((err as Error).message); setSaving(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title="New payout batch"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={saving}>Create</Button></>}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Batch name"><Input value={form.name} onChange={set('name')} required placeholder="e.g. September 2026 commissions" /></Field>
        <Field label="Payment month"><Input value={form.paymentMonth} onChange={set('paymentMonth')} placeholder="YYYY-MM" /></Field>
        {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      </form>
    </Dialog>
  );
}