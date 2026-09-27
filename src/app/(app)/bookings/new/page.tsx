'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useApi } from '@/lib/useApi';
import { Card, Field, Input, PageHeader, Select, Button } from '@/components/ui';
import { fetcher } from '@/lib/fetcher';

type UnitOption = { id: string; unitNo: string; towerName: string | null; projectName: string | null; price: string | null; status: string };
type ProjectOption = { id: string; name: string };

export default function NewBookingPage() {
  const router = useRouter();
  const projects = useApi<{ items: ProjectOption[] }>('/api/projects');
  const [form, setForm] = useState({ projectId: '', towerId: '', unitId: '', customerName: '', phone: '', email: '', saleValue: '', bookingAmount: '', notes: '' });
  const [units, setUnits] = useState<UnitOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  useEffect(() => {
    const allProjects = projects.data?.items ?? [];
    if (allProjects.length === 1 && !form.projectId) setForm((f) => ({ ...f, projectId: allProjects[0].id }));
  }, [projects.data, form.projectId]);

  const pickProject = async (projectId: string) => {
    setForm((f) => ({ ...f, projectId, towerId: '', unitId: '' }));
    setUnits([]);
    const res = await fetcher<{ items: UnitOption[] }>(`/api/units?projectId=${projectId}&status=AVAILABLE`);
    setUnits(res.items.filter((u) => u.status === 'AVAILABLE'));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetcher<{ booking: { id: string } }>('/api/bookings', {
        method: 'POST',
        body: JSON.stringify({
          unitId: form.unitId,
          customerName: form.customerName,
          initialPayment: form.bookingAmount ? Number(form.bookingAmount) : undefined,
          saleValue: form.saleValue ? Number(form.saleValue) : undefined,
          notes: form.notes,
        }),
      });
      router.push(`/bookings/${res.booking.id}`);
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="New booking" subtitle="Pick an available unit and capture the deal" action={<Link href="/bookings" className="btn-ghost">Cancel</Link>} />
      <form onSubmit={submit} className="card space-y-5 p-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Project">
            <Select value={form.projectId} onChange={(e) => pickProject(e.target.value)}>
              <option value="">Select project…</option>
              {projects.data?.items?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
          <Field label="Unit">
            <Select value={form.unitId} onChange={set('unitId')} disabled={!form.projectId}>
              <option value="">Available units…</option>
              {units.map((u) => <option key={u.id} value={u.id}>{u.towerName ? `${u.towerName} · ` : ''}{u.unitNo} — {u.price ? `₹ ${Number(u.price).toLocaleString('en-IN')}` : ''}</option>)}
            </Select>
          </Field>
          <Field label="Customer name">
            <Input value={form.customerName} onChange={set('customerName')} required placeholder="e.g. Ananya Sharma" />
          </Field>
          <Field label="Phone">
            <Input value={form.phone} onChange={set('phone')} required placeholder="+91 …" />
          </Field>
          <Field label="Email">
            <Input type="email" value={form.email} onChange={set('email')} placeholder="Optional" />
          </Field>
          <Field label="Sale value (₹)">
            <Input type="number" value={form.saleValue} onChange={set('saleValue')} placeholder="Total deal value" />
          </Field>
          <Field label="Initial payment (₹)">
            <Input type="number" value={form.bookingAmount} onChange={set('bookingAmount')} placeholder="Amount paid at booking" />
          </Field>
        </div>
        <Field label="Notes"><Input value={form.notes} onChange={set('notes')} placeholder="Payment plan, terms…" /></Field>
        {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <div className="flex justify-end gap-2">
          <Link href="/bookings" className="btn-secondary">Cancel</Link>
          <Button type="submit" loading={saving}>Create booking</Button>
        </div>
      </form>
    </div>
  );
}