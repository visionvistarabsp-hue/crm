'use client';

import { useMemo, useState } from 'react';
import { useApi } from '@/lib/useApi';
import { ApiErrorView, fetcher } from '@/lib/fetcher';
import { Button, Card, Dialog, EmptyState, Field, Input, PageHeader, Pagination, Spinner, StatusBadge, Table } from '@/components/ui';

type Customer = {
  id: string; name: string; phone: string; email: string; type: string; status: string;
  source: string; createdAt: string; ownerName?: string | null;
};

export default function CustomersPage() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [open, setOpen] = useState(false);
  const [ownerId, setOwnerId] = useState('');
  const url = useMemo(() => {
    const sp = new URLSearchParams({ page: String(page), pageSize: '25' });
    if (debouncedQ) sp.set('q', debouncedQ);
    if (ownerId) sp.set('ownerId', ownerId);
    return `/api/customers?${sp.toString()}`;
  }, [page, debouncedQ, ownerId]);
  const { data, error, loading, reload } = useApi<{ items: Customer[]; total: number }>(url, { deps: [page, debouncedQ, ownerId] });

  return (
    <div>
      <PageHeader title="Customers" subtitle="Converted prospects with booking history" action={<Button onClick={() => setOpen(true)}>New customer</Button>} />
      <div className="card mb-4 flex flex-col gap-3 p-4 sm:flex-row">
        <Input placeholder="Search name, phone, email…" value={q} onChange={(e) => { setQ(e.target.value); setTimeout(() => setDebouncedQ(e.target.value), 400); }} />
      </div>

      {loading && !data && <div className="flex justify-center p-10"><Spinner /></div>}
      <ApiErrorView error={error} onRetry={reload} />

      <div className="card">
        <Table head={['Customer', 'Contact', 'Type', 'Source', 'Created']}>
          {data?.items?.map((c) => (
            <tr key={c.id} className="hover:bg-primary-50/40">
              <td className="td"><p className="font-medium text-ink">{c.name}</p></td>
              <td className="td">
                <p className="text-ink-muted">{c.phone || '—'}</p>
                <p className="text-xs text-ink-faint">{c.email || ''}</p>
              </td>
              <td className="td capitalize text-ink-muted">{c.type?.toLowerCase()}</td>
              <td className="td text-ink-muted">{c.source ?? '—'}</td>
              <td className="td text-ink-faint">{new Date(c.createdAt).toLocaleDateString('en-IN')}</td>
            </tr>
          ))}
        </Table>
        {data && data.items.length === 0 && <EmptyState title="No customers found" />}
        {data && <Pagination page={page} total={data.total} pageSize={25} onChange={setPage} />}
      </div>

      <CustomerDialog open={open} onClose={() => setOpen(false)} onCreated={() => { setOpen(false); reload(); }} />
    </div>
  );
}

function CustomerDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({ name: '', phone: '', email: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await fetcher('/api/customers', { method: 'POST', body: JSON.stringify(form) });
      onCreated();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="New customer"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={saving}>Create</Button></>}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Full name"><Input value={form.name} onChange={set('name')} required placeholder="Customer name" /></Field>
        <Field label="Phone"><Input value={form.phone} onChange={set('phone')} required placeholder="+91 …" /></Field>
        <Field label="Email"><Input type="email" value={form.email} onChange={set('email')} placeholder="Optional" /></Field>
        {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      </form>
    </Dialog>
  );
}