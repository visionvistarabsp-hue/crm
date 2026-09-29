'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useApi } from '@/lib/useApi';
import { ApiErrorView, fetcher } from '@/lib/fetcher';
import { Button, Card, CardHeader, Field, Input, PageHeader, Spinner } from '@/components/ui';

type AutomationAction = { type?: string; action?: string };
type AutomationRule = {
  id: string; name: string; trigger?: string; actions?: AutomationAction[]; isActive: boolean;
};

type ReadinessCheck = { ok: boolean; source?: string; detail?: string };
type Readiness = { checks: Record<string, ReadinessCheck> };

const CHECK_LABELS: Record<string, string> = {
  database: 'Database connection',
  encryptionKey: 'Encryption key (env)',
  meta: 'Meta / Facebook leads',
  email: 'Email delivery (SMTP / Resend)',
  webhookSecret: 'Lead webhook secret',
  timezone: 'Timezone',
};

/** `actions` is a free-form jsonb array, so no key inside it is guaranteed to be present. */
function describeAction(a: AutomationAction): string {
  const label = typeof a.type === 'string' ? a.type : typeof a.action === 'string' ? a.action : '';
  return label ? label.replace(/_/g, ' ') : 'unspecified action';
}

function describeTrigger(trigger?: string): string {
  return typeof trigger === 'string' && trigger ? trigger.replace(/_/g, ' ').toLowerCase() : 'unknown trigger';
}

export default function SettingsPage() {
  const { data, error, loading, reload } = useApi<{ items: AutomationRule[] }>('/api/automation-rules');
  const [workingId, setWorkingId] = useState<string | null>(null);

  const readiness = useApi<Readiness>('/api/settings/readiness');
  const [savingTimezone, setSavingTimezone] = useState(false);

  const saveTimezone = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSavingTimezone(true);
    try {
      const value = (e.currentTarget.elements.namedItem('timezone') as HTMLInputElement).value.trim();
      await fetcher('/api/settings', { method: 'POST', body: JSON.stringify({ key: 'app.timezone', value }) });
      await readiness.reload();
    } catch (err) { alert((err as Error).message); }
    finally { setSavingTimezone(false); }
  };

  const toggle = async (id: string) => {
    setWorkingId(id);
    try { await fetcher(`/api/automation-rules/${id}`, { method: 'POST' }); await reload(); }
    catch (e) { alert((e as Error).message); }
    finally { setWorkingId(null); }
  };

  const me = useApi<{ newLeadAlertsEnabled: boolean }>('/api/auth/me');
  const [savingAlerts, setSavingAlerts] = useState(false);

  const toggleLeadAlerts = async (next: boolean) => {
    setSavingAlerts(true);
    try {
      await fetcher('/api/auth/me', { method: 'PATCH', body: JSON.stringify({ newLeadAlertsEnabled: next }) });
      await me.reload();
    } catch (e) { alert((e as Error).message); }
    finally { setSavingAlerts(false); }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Settings" subtitle="Automations, integration keys and preferences" />

      <Card className="mb-6">
        <CardHeader title="Go-live checklist" subtitle="What a fresh instance needs before leads can flow" />
        {readiness.loading && !readiness.data && <div className="flex justify-center p-6"><Spinner /></div>}
        <ApiErrorView error={readiness.error} onRetry={readiness.reload} />
        {readiness.data && (
          <div>
            <div className="space-y-2">
              {Object.entries(CHECK_LABELS).map(([key, label]) => {
                const c = readiness.data?.checks[key];
                return (
                  <div key={key} className="flex items-center justify-between gap-3 rounded-2xl bg-surface p-3 shadow-clay-sm">
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${c?.ok ? 'bg-primary-600' : 'bg-amber-500'}`} />
                      <p className="text-sm font-medium text-ink">{label}</p>
                    </div>
                    <p className="text-xs text-ink-faint">
                      {key === 'timezone' && c?.detail
                        ? `${c.detail}${c.source && c.source !== 'default' ? ` (from ${c.source})` : ''}`
                        : c?.ok
                          ? `set via ${c.source ?? 'env'}`
                          : 'not set'}
                    </p>
                  </div>
                );
              })}
            </div>
            <form onSubmit={saveTimezone} className="mt-4 flex items-end gap-3">
              <Field label="Timezone (IANA)" hint="Used for reminder and digest scheduling">
                <Input
                  name="timezone"
                  defaultValue={readiness.data?.checks.timezone?.detail ?? ''}
                  placeholder="Asia/Kolkata"
                />
              </Field>
              <Button type="submit" disabled={savingTimezone}>Save timezone</Button>
            </form>
          </div>
        )}
      </Card>

      <Card className="mb-6">
        <CardHeader title="Automation rules" subtitle="Triggers fire actions across the CRM" />
        {loading && !data && <div className="flex justify-center p-6"><Spinner /></div>}
        <ApiErrorView error={error} onRetry={reload} />
        <div className="space-y-3">
          {data?.items?.map((r) => {
            const actionLabels = (r.actions ?? []).map(describeAction);
            return (
            <div key={r.id} className="flex items-center justify-between rounded-2xl bg-surface p-3 shadow-clay-sm">
              <div>
                <p className="font-medium text-ink">{r.name}</p>
                <p className="text-xs text-ink-faint">
                  on {describeTrigger(r.trigger)} → {actionLabels.length ? actionLabels.join(', ') : 'no actions'}
                </p>
              </div>
              <Button variant={r.isActive ? 'secondary' : 'primary'} className="!py-1" disabled={workingId === r.id} onClick={() => toggle(r.id)}>
                {r.isActive ? 'Disable' : 'Enable'}
              </Button>
            </div>
            );
          })}
          {data && data.items.length === 0 && <p className="text-sm text-ink-faint">No automation rules yet.</p>}
        </div>
      </Card>

      <Card>
        <CardHeader title="Integration keys" subtitle="Meta Webhook secret for lead capture" />
        <div className="mb-4 flex items-center justify-between gap-3 rounded-2xl bg-surface p-3 shadow-clay-sm">
          <p className="text-xs text-ink-faint">Encrypted keys such as the SMTP app password or Resend API key are managed separately.</p>
          <Link
            href="/settings/keys"
            className="shrink-0 text-sm font-semibold text-primary-700 hover:underline"
          >
            Email keys
          </Link>
        </div>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const value = (e.currentTarget.elements.namedItem('secret') as HTMLInputElement).value;
            await fetcher('/api/settings', { method: 'POST', body: JSON.stringify({ key: 'integrations.meta_webhook_secret', value }) });
            await readiness.reload();
            alert('Saved.');
          }}
        >
          <Field label="Webhook secret" hint="Matches the x-webhook-secret header on POST /api/webhooks/leads">
            <Input name="secret" placeholder="Leave blank to allow unauthenticated webhooks" />
          </Field>
          <Button type="submit">Save keys</Button>
        </form>
      </Card>

      <Card className="mt-6">
        <CardHeader title="Your notifications" subtitle="Personal preferences, for you only" />
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-1"
            checked={me.data?.newLeadAlertsEnabled ?? true}
            disabled={savingAlerts || me.loading}
            onChange={(e) => toggleLeadAlerts(e.target.checked)}
          />
          <span>
            <span className="block font-medium">Email me about new leads</span>
            <span className="block text-sm opacity-70">
              Turn this off and you stop receiving the alert when a lead is assigned to you and
              the later reminder to your manager. New-lead emails sent to the whole team are not
              affected. Separate from follow-up reminders, which are controlled elsewhere.
            </span>
          </span>
        </label>
      </Card>
    </div>
  );
}