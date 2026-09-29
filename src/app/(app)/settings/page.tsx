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
          <p className="text-xs text-ink-faint">Encrypted keys such as the Resend API key are managed separately.</p>
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
              Turn this off and you stop receiving both the alert when a lead is assigned to you and
              the later reminder to your manager. Separate from follow-up reminders, which are
              controlled elsewhere.
            </span>
          </span>
        </label>
      </Card>
    </div>
  );
}