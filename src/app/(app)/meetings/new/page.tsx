'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Button, Field, Input, PageHeader, Select, Textarea } from '@/components/ui';
import EntityPicker, { toLocalInput, type Picked } from '@/components/EntityPicker';
import { fetcher } from '@/lib/fetcher';
import { useApi } from '@/lib/useApi';
import { MEETING_TYPES } from '@/lib/constants';

function defaultSchedule(): string {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() > 30 ? 60 : 30);
  return toLocalInput(d);
}

type Project = { id: string; name: string; location?: string | null };

export default function NewMeetingPage() {
  const router = useRouter();
  const [picked, setPicked] = useState<Picked>(null);
  const [form, setForm] = useState({
    type: 'SITE_VISIT',
    projectId: '',
    visitNumber: '1',
    title: '',
    scheduledAt: defaultSchedule(),
    location: '',
    notes: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projectsUrl = useMemo(() => '/api/projects?pageSize=100', []);
  const { data: projectData } = useApi<{ items: Project[] }>(projectsUrl, { deps: [] });

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const isVisit = form.type === 'SITE_VISIT';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!picked) {
      setError('Pick a lead or customer to continue.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await fetcher('/api/meetings', {
        method: 'POST',
        body: JSON.stringify({
          leadId: picked.kind === 'lead' ? picked.id : undefined,
          customerId: picked.kind === 'customer' ? picked.id : undefined,
          type: form.type,
          visitNumber: isVisit ? Number(form.visitNumber) || 1 : undefined,
          title: form.title || undefined,
          projectId: form.projectId || undefined,
          scheduledAt: new Date(form.scheduledAt).toISOString(),
          location: form.location || undefined,
          notes: form.notes || undefined,
        }),
      });
      router.push('/meetings');
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Schedule meeting"
        subtitle="Book a site visit or a call with a prospect"
        action={<Link href="/meetings" className="btn-secondary">Cancel</Link>}
      />

      <form onSubmit={submit} className="card space-y-6 p-7">
        <EntityPicker
          value={picked}
          onChange={setPicked}
          hint="Meetings must be attached to a lead or a customer so the activity is logged."
          autoFocus
        />

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Type">
            <Select value={form.type} onChange={set('type')}>
              {MEETING_TYPES.map((t) => (
                <option key={t} value={t}>{t.replace(/_/g, ' ').toLowerCase()}</option>
              ))}
            </Select>
          </Field>
          <Field label="Scheduled at">
            <Input type="datetime-local" value={form.scheduledAt} onChange={set('scheduledAt')} required />
          </Field>
          {isVisit && (
            <>
              <Field label="Project">
                <Select value={form.projectId} onChange={set('projectId')}>
                  <option value="">Not project specific</option>
                  {projectData?.items?.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}{p.location ? ` — ${p.location}` : ''}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Visit number" hint="Tracks repeat visits per lead">
                <Select value={form.visitNumber} onChange={set('visitNumber')}>
                  {[1, 2, 3].map((n) => <option key={n} value={n}>Visit #{n}</option>)}
                </Select>
              </Field>
            </>
          )}
        </div>

        <Field label="Title" hint="Shown on the calendar">
          <Input value={form.title} onChange={set('title')} placeholder="Site visit — Whitefield 3BHK" />
        </Field>

        <Field label="Location">
          <Input value={form.location} onChange={set('location')} placeholder="Project site office / customer office" />
        </Field>

        <Field label="Notes">
          <Textarea value={form.notes} onChange={set('notes')} placeholder="What to cover, who is joining, documents to carry…" />
        </Field>

        {error && (
          <p role="alert" className="rounded-xl bg-rose-100 px-4 py-3 text-sm font-medium text-rose-800 shadow-clay-inset-sm">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-3">
          <Link href="/meetings" className="btn-secondary">Cancel</Link>
          <Button type="submit" loading={saving}>Schedule meeting</Button>
        </div>
      </form>
    </div>
  );
}
