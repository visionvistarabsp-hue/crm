'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Card, Field, Input, PageHeader, Select, Textarea, Button } from '@/components/ui';
import { fetcher } from '@/lib/fetcher';
import { LEAD_SOURCES, PRIORITIES, PROPERTY_TYPES } from '@/lib/constants';

const EMPTY = {
  name: '', phone: '', whatsapp: '', email: '', source: 'FACEBOOK', campaign: '', adName: '',
  budget: '', preferredLocation: '', propertyType: '', requirement: '', priority: 'MEDIUM', notes: '',
};

export default function NewLeadPage() {
  const router = useRouter();
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetcher<{ lead: { id: string }; duplicates: unknown[] }>('/api/leads', {
        method: 'POST',
        body: JSON.stringify({ ...form, budget: form.budget ? form.budget : null }),
      });
      router.push(`/leads/${res.lead.id}${res.duplicates?.length ? '?duplicates=1' : ''}`);
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="New lead" subtitle="Capture a prospect from any channel" action={<Link href="/leads" className="btn-ghost">Cancel</Link>} />
      <form onSubmit={submit} className="card space-y-5 p-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name" hint="As provided by the prospect">
            <Input value={form.name} onChange={set('name')} required placeholder="e.g. Ravi Kumar" />
          </Field>
          <Field label="Phone">
            <Input value={form.phone} onChange={set('phone')} required placeholder="+91 98xxxxxx" />
          </Field>
          <Field label="WhatsApp">
            <Input value={form.whatsapp} onChange={set('whatsapp')} placeholder="Optional" />
          </Field>
          <Field label="Email">
            <Input type="email" value={form.email} onChange={set('email')} placeholder="Optional" />
          </Field>
          <Field label="Source">
            <Select value={form.source} onChange={set('source')}>
              {LEAD_SOURCES.map((s) => <option key={s}>{s}</option>)}
            </Select>
          </Field>
          <Field label="Campaign">
            <Input value={form.campaign} onChange={set('campaign')} placeholder="Optional" />
          </Field>
          <Field label="Ad name">
            <Input value={form.adName} onChange={set('adName')} placeholder="Optional" />
          </Field>
          <Field label="Budget (₹)">
            <Input type="number" value={form.budget} onChange={set('budget')} placeholder="e.g. 5500000" />
          </Field>
          <Field label="Preferred location">
            <Input value={form.preferredLocation} onChange={set('preferredLocation')} placeholder="e.g. Whitefield, Bengaluru" />
          </Field>
          <Field label="Property type">
            <Select value={form.propertyType} onChange={set('propertyType')}>
              <option value="">Any</option>
              {PROPERTY_TYPES.map((p) => <option key={p}>{p}</option>)}
            </Select>
          </Field>
          <Field label="Priority">
            <Select value={form.priority} onChange={set('priority')}>
              {PRIORITIES.map((p) => <option key={p}>{p}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Requirement">
          <Textarea value={form.requirement} onChange={set('requirement')} placeholder="Bedrooms, budget range, timeline…" />
        </Field>
        <Field label="Notes">
          <Textarea value={form.notes} onChange={set('notes')} placeholder="Anything valuable for the sales team" />
        </Field>
        {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <div className="flex justify-end gap-2">
          <Link href="/leads" className="btn-secondary">Cancel</Link>
          <Button type="submit" loading={saving}>Create lead</Button>
        </div>
      </form>
    </div>
  );
}