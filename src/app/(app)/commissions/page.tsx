'use client';

import { useState } from 'react';
import { useApi } from '@/lib/useApi';
import { ApiErrorView, fetcher } from '@/lib/fetcher';
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, PageHeader, Select, Spinner, StatusBadge, Table } from '@/components/ui';
import { COMMISSION_TYPES, PAYABLE_TO } from '@/lib/constants';

type Rule = {
  id: string; name: string; type: string; payableTo: string; rate: string | null;
  fixedAmount: string | null; isActive: boolean; version: number;
};

type Dashboard = {
  grossCommission: number; pending: number; payable: number; approved: number;
  paid: number; reversed: number; outstandingBalance: number; snapshotCount: number;
};

const rate = (n: any) => {
  const v = Number(n);
  return isNaN(v) ? 0 : v;
};

export default function CommissionsPage() {
  const rules = useApi<{ items: Rule[] }>('/api/commissions/rules');
  const dash = useApi<Dashboard | null>('/api/commissions/dashboard');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(true);

  const visible = rules.data?.items?.filter((r) => (active ? r.isActive : !r.isActive)) ?? [];
  const d = dash.data;

  return (
    <div>
      <PageHeader title="Commissions" subtitle="Rules, entitlements and ledger" action={<Button onClick={() => setOpen(true)}>New rule</Button>} />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Stat label="Payable" value={d ? `₹ ${rate(d.payable).toLocaleString('en-IN')}` : '—'} sub="Earned, awaiting payout" />
        <Stat label="Pending" value={d ? `₹ ${rate(d.pending).toLocaleString('en-IN')}` : '—'} sub="Collected, to be approved" />
        <Stat label="Outstanding balance" value={d ? `₹ ${rate(d.outstandingBalance).toLocaleString('en-IN')}` : '—'} sub={`${d ? rate(d.snapshotCount) : 0} snapshots on record`} />
      </div>

      <Card>
        <CardHeader
          title="Commission rules"
          subtitle="Versioned — editing creates a new version"
          action={
            <div className="flex gap-1">
              <button className={active ? 'btn-primary !py-1' : 'btn-secondary !py-1'} onClick={() => setActive(true)}>Active</button>
              <button className={!active ? 'btn-primary !py-1' : 'btn-secondary !py-1'} onClick={() => setActive(false)}>Archived</button>
            </div>
          }
        />
        <Table head={['Name', 'Type', 'Payable to', 'Rate', 'Version', 'Status']}>
          {visible.map((r) => (
            <tr key={r.id}>
              <td className="td font-medium text-ink">{r.name}</td>
              <td className="td"><Badge tone="purple">{r.type.replace(/_/g, ' ')}</Badge></td>
              <td className="td text-ink-muted">{r.payableTo.replace(/_/g, ' ')}</td>
              <td className="td tabular-nums">
                {r.type === 'FIXED' ? `₹ ${rate(r.fixedAmount).toLocaleString('en-IN')}` : r.type === 'SLAB_BASED' ? 'Slab' : `${rate(r.rate)}%`}
              </td>
              <td className="td text-ink-faint">v{r.version}</td>
              <td className="td"><StatusBadge status={r.isActive ? 'ACTIVE' : 'INACTIVE'} /></td>
            </tr>
          ))}
        </Table>
        {rules.data && visible.length === 0 && <EmptyState title="No rules" action={<Button onClick={() => setOpen(true)}>Create a rule</Button>} />}
      </Card>

      <RuleDialog open={open} onClose={() => setOpen(false)} onDone={() => { setOpen(false); rules.reload(); dash.reload(); }} />
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl bg-surface p-4 shadow-clay-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-faint">{label}</p>
      <p className="mt-1 text-xl font-bold text-ink">{value}</p>
      {sub && <p className="text-xs text-ink-faint">{sub}</p>}
    </div>
  );
}

function RuleDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ name: '', type: 'PERCENTAGE', payableTo: 'SALES_EXECUTIVE', rate: '', fixedAmount: '', projectId: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await fetcher('/api/commissions/rules', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          type: form.type,
          payableTo: form.payableTo,
          rate: form.rate ? Number(form.rate) : null,
          fixedAmount: form.fixedAmount ? Number(form.fixedAmount) : null,
          projectId: form.projectId || null,
        }),
      });
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="New commission rule"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={saving}>Create</Button></>}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name"><Input value={form.name} onChange={set('name')} required placeholder="e.g. Sales executive — after sale" /></Field>
        <Field label="Type">
          <Select value={form.type} onChange={set('type')}>
            {COMMISSION_TYPES.map((t) => <option key={t}>{t}</option>)}
          </Select>
        </Field>
        <Field label="Payable to">
          <Select value={form.payableTo} onChange={set('payableTo')}>
            {PAYABLE_TO.map((t) => <option key={t}>{t}</option>)}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Rate %"><Input type="number" step="0.1" value={form.rate} onChange={set('rate')} /></Field>
          <Field label="Fixed amount (₹)"><Input type="number" value={form.fixedAmount} onChange={set('fixedAmount')} /></Field>
        </div>
        {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      </form>
    </Dialog>
  );
}