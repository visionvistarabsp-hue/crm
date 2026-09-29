'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Card, CardHeader, Field, Input, PageHeader, Select, Textarea } from '@/components/ui';
import { fetcher } from '@/lib/fetcher';
import { LEAD_SOURCES } from '@/lib/constants';

const SOURCES: Array<{ value: (typeof LEAD_SOURCES)[number]; label: string }> = [
  { value: 'MANUAL', label: 'Walk-in / manual' },
  { value: 'WHATSAPP', label: 'WhatsApp' },
  { value: 'INSTAGRAM', label: 'Instagram' },
  { value: 'FACEBOOK', label: 'Facebook' },
  { value: 'YOUTUBE_ADS', label: 'YouTube ad' },
  { value: 'NINE9ACRES', label: '99acres' },
  { value: 'MAGICBRICKS', label: 'MagicBricks' },
  { value: 'REALESTATE_INDIA', label: 'RealEstateIndia' },
  { value: 'WEBSITE', label: 'Website' },
  { value: 'REFERRAL', label: 'Referral' },
];

export default function NewLeadPage() {
  const router = useRouter();
  const [form, setForm] = useState({ name: '', phone: '', email: '', source: 'MANUAL', requirement: '', priority: 'MEDIUM' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!form.name.trim()) return setError('Name is required');
    if (!form.phone.trim() && !form.email.trim()) return setError('Add a phone number or an email so we can reach them');

    setSaving(true);
    try {
      const res = await fetcher<{ lead: { id: string; leadNo: string } }>('/api/leads', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name.trim(),
          phone: form.phone.trim() || undefined,
          email: form.email.trim() || undefined,
          source: form.source,
          requirement: form.requirement.trim() || undefined,
          priority: form.priority,
        }),
      });
      setForm({ name: '', phone: '', email: '', source: 'MANUAL', requirement: '', priority: 'MEDIUM' });
      router.push(`/my-leads?highlight=${res.lead.id}`);
    } catch (e2) {
      setError((e2 as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-lg">
      <PageHeader title="New Lead" subtitle="Name and a way to reach them — that is enough" />

      <Card>
        <form className="space-y-4" onSubmit={submit}>
          <Field label="Name" hint="Required">
            <Input value={form.name} onChange={set('name')} placeholder="e.g. Ramesh Sharma" autoComplete="name" />
          </Field>

          <Field label="Phone" hint="Add a phone or an email — one is required">
            <Input value={form.phone} onChange={set('phone')} placeholder="98765 43210" inputMode="tel" autoComplete="tel" />
          </Field>

          <Field label="Email" hint="Optional">
            <Input value={form.email} onChange={set('email')} placeholder="name@example.com" inputMode="email" autoComplete="email" />
          </Field>

          <Field label="Where did they come from?">
            <Select value={form.source} onChange={set('source')}>
              {SOURCES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="What are they looking for?" hint="Optional">
            <Textarea value={form.requirement} onChange={set('requirement')} rows={3} placeholder="2BHK in Gaur City, budget around 60L" />
          </Field>

          <Field label="How serious?">
            <Select value={form.priority} onChange={set('priority')}>
              <option value="LOW">Low</option>
              <option value="MEDIUM">Medium</option>
              <option value="HIGH">High</option>
              <option value="URGENT">Urgent</option>
            </Select>
          </Field>

          {error && (
            <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700" role="alert">
              {error}
            </p>
          )}

          <Button type="submit" loading={saving} className="w-full !py-3 text-base">
            Save lead
          </Button>
        </form>
      </Card>
    </div>
  );
}
