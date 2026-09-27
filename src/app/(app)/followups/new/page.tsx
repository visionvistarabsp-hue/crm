'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Field, Input, PageHeader, Select, Textarea } from '@/components/ui';
import EntityPicker, { toLocalInput, type Picked } from '@/components/EntityPicker';
import { fetcher } from '@/lib/fetcher';
import { FOLLOWUP_TYPES } from '@/lib/constants';

/** Default the schedule to the next half-hour boundary, in the user's timezone. */
function defaultSchedule(): string {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() > 30 ? 60 : 30);
  return toLocalInput(d);
}

export default function NewFollowupPage() {
  const router = useRouter();
  const [picked, setPicked] = useState<Picked>(null);
  const [form, setForm] = useState({
    type: 'CALL',
    scheduledAt: defaultSchedule(),
    remindBeforeMinutes: '60',
    notes: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!picked) {
      setError('Pick a lead or customer to continue.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await fetcher('/api/followups', {
        method: 'POST',
        body: JSON.stringify({
          // A follow-up attaches to exactly one of the two, never both.
          leadId: picked.kind === 'lead' ? picked.id : undefined,
          customerId: picked.kind === 'customer' ? picked.id : undefined,
          type: form.type,
          scheduledAt: new Date(form.scheduledAt).toISOString(),
          remindBeforeMinutes: Number(form.remindBeforeMinutes) || 60,
          notes: form.notes || undefined,
        }),
      });
      router.push('/followups');
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Schedule follow-up"
        subtitle="Plan the next outreach and get reminded before it is due"
        action={<Link href="/followups" className="btn-secondary">Cancel</Link>}
      />

      <form onSubmit={submit} className="card space-y-6 p-7">
        <EntityPicker
          value={picked}
          onChange={setPicked}
          hint="Follow-ups must be attached to a lead or a customer so the activity is logged."
          autoFocus
        />

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Channel">
            <Select value={form.type} onChange={set('type')}>
              {FOLLOWUP_TYPES.map((t) => (
                <option key={t} value={t}>{t.replace(/_/g, ' ').toLowerCase()}</option>
              ))}
            </Select>
          </Field>
          <Field label="Scheduled at">
            <Input type="datetime-local" value={form.scheduledAt} onChange={set('scheduledAt')} required />
          </Field>
          <Field label="Remind me before" hint="Minutes ahead of the scheduled time">
            <Select value={form.remindBeforeMinutes} onChange={set('remindBeforeMinutes')}>
              {[0, 15, 30, 60, 120, 240, 1440].map((m) => (
                <option key={m} value={String(m)}>
                  {m === 0 ? 'At the scheduled time' : m === 1440 ? '1 day before' : `${m} minutes before`}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Notes" hint="Agenda, context or what to offer">
          <Textarea value={form.notes} onChange={set('notes')} placeholder="Discuss pricing for the 3BHK in Whitefield…" />
        </Field>

        {error && (
          <p role="alert" className="rounded-xl bg-rose-100 px-4 py-3 text-sm font-medium text-rose-800 shadow-clay-inset-sm">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-3">
          <Link href="/followups" className="btn-secondary">Cancel</Link>
          <Button type="submit" loading={saving}>Schedule follow-up</Button>
        </div>
      </form>
    </div>
  );
}
