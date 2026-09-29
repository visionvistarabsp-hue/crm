'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Check, CheckCircle2, Copy, ExternalLink, RefreshCw } from 'lucide-react';
import { Badge, Button, Card, CardHeader, PageHeader, Spinner, cn } from '@/components/ui';
import { ApiErrorView, fetcher, useApi } from '@/lib/fetcher';

/**
 * Integration status is reported honestly: a channel only counts as Ready when
 * the app actually has a working path for it. "In-app" means notifications are
 * written to the notifications table and shown in the bell menu.
 */
const INTEGRATIONS: Array<{
  name: string;
  status: 'Ready' | 'Not built';
  desc: string;
  href?: string;
}> = [
  {
    name: 'WhatsApp Business',
    status: 'Ready',
    desc: 'New leads are broadcast to every active team member on WhatsApp via the WhatsApp Business Cloud API (template message). Add your sender under Settings → Integration keys.',
    href: '/settings/keys',
  },
  {
    name: 'Email (SMTP / Resend)',
    status: 'Ready',
    desc: 'Automated emails (reminders, digests, client payment alerts) go through SMTP when configured, with Resend as the fallback. Add your sender under Settings → Integration keys.',
    href: '/settings/keys',
  },
  {
    name: 'Slack',
    status: 'Not built',
    desc: 'Planned. No team alerts are sent out of the app yet.',
  },
];

const TONE: Record<string, 'green' | 'gray'> = {
  Ready: 'green',
  'Not built': 'gray',
};

type MetaStatus = {
  configured?: boolean;
  verifyTokenConfigured?: boolean;
  appSecretConfigured?: boolean;
  facebookPageConfigured?: boolean;
  instagramConfigured?: boolean;
  checks?: Array<{ name: string; ok: boolean; detail: string }>;
};

type TestResult =
  | { kind: 'ok'; message: string }
  | { kind: 'error'; message: string }
  | null;

export default function IntegrationsPage() {
  const { data, error, loading, reload } = useApi<MetaStatus>('/api/integrations/meta/status');
  const [copied, setCopied] = useState(false);
  const [testResult, setTestResult] = useState<TestResult>(null);
  const [testing, setTesting] = useState(false);

  const callbackUrl =
    typeof window !== 'undefined' ? `${window.location.origin}/api/webhooks/meta/leads` : '';

  const ready = Boolean(data?.configured && data?.appSecretConfigured);

  const copyCallback = async () => {
    try {
      await navigator.clipboard.writeText(callbackUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — ignore */
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetcher<{ ok: boolean; message: string }>('/api/integrations/meta/test', {
        method: 'POST',
      });
      setTestResult({ kind: 'ok', message: res.message });
    } catch (e) {
      setTestResult({ kind: 'error', message: (e as Error).message });
    } finally {
      setTesting(false);
      reload();
    }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Integrations"
        subtitle="External lead sources and notification channels"
      />

      {/* Meta Lead Ads setup */}
      <Card className="mb-6">
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              Meta (Facebook/Instagram) Ads
              <Badge tone={ready ? 'green' : 'amber'}>
                {ready ? 'Ready' : 'Needs setup'}
              </Badge>
            </span>
          }
          subtitle="Incoming leads land via webhook at POST /api/webhooks/meta/leads"
          action={
            <Button variant="secondary" className="!px-3 !py-2" onClick={reload} disabled={loading}>
              <RefreshCw size={16} className={cn(loading && 'animate-spin')} />
            </Button>
          }
        />

        {/* Live status checks */}
        <div className="mb-5 space-y-2">
          {loading && !data && (
            <div className="flex items-center gap-2 text-sm text-ink-faint">
              <Spinner /> Reading integration status…
            </div>
          )}
          <ApiErrorView error={error} onRetry={reload} />
          {data?.checks?.map((c) => (
            <div key={c.name} className="flex items-start gap-2 text-sm">
              {c.ok ? (
                <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-emerald-600" />
              ) : (
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-rose-500" />
              )}
              <span className={c.ok ? 'text-ink-muted' : 'text-ink'}>
                <span className="font-semibold">{c.name.replace(/-/g, ' ')}</span>
                {' — '}
                {c.detail}
              </span>
            </div>
          ))}
        </div>

        {/* Setup steps */}
        <div className="space-y-0">
          <Step
            n={1}
            title="Save your credentials"
            done={Boolean(data?.appSecretConfigured && data?.configured)}
          >
            <p className="text-sm text-ink-muted">
              In your Meta app (developers.facebook.com) you need an App Secret, a Page Access
              Token and a Verify Token. Paste them under{' '}
              <Link className="font-semibold text-primary underline" href="/settings/keys">
                Settings → Integration keys →
              </Link>{' '}
              select Meta Lead Ads, fill the three values and hit Save.
            </p>
          </Step>
          <Step
            n={2}
            title="Point the webhook at this app"
            done={Boolean(data?.verifyTokenConfigured)}
          >
            <p className="text-sm text-ink-muted">
              In Meta: App → (add a) Webhook → product <strong>Leads</strong> → add the following
              callback URL and the Verify Token you saved in step 1:
            </p>
            <div className="mt-3 flex items-center gap-2">
              <code className="flex-1 truncate rounded-lg bg-ink/5 px-3 py-2 text-sm text-ink">
                {callbackUrl}
              </code>
              <Button variant="secondary" className="!px-3 !py-2" onClick={copyCallback}>
                {copied ? <Check size={16} /> : <Copy size={16} />}
                <span className="ml-1.5">{copied ? 'Copied' : 'Copy'}</span>
              </Button>
            </div>
          </Step>
          <Step
            n={3}
            title="Send a test lead to confirm delivery"
            done={testResult?.kind === 'ok'}
          >
            <p className="text-sm text-ink-muted">
              This sends a synthetic, realistically-signed Meta ping through the real webhook
              endpoint. It verifies the signature and that an (ignored) receipt is recorded —
              no real ad is created.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button onClick={runTest} loading={testing}>
                {testing ? (
                  'Sending test lead…'
                ) : (
                  <>
                    <ArrowUpRight size={16} /> Send test lead
                  </>
                )}
              </Button>
              {testResult && (
                <span
                  className={cn(
                    'text-sm',
                    testResult.kind === 'ok' ? 'text-emerald-700' : 'text-rose-600',
                  )}
                >
                  {testResult.kind === 'ok' && (
                    <CheckCircle2 size={15} className="mr-1 inline" />
                  )}
                  {testResult.message}
                </span>
              )}
            </div>
          </Step>
        </div>
      </Card>

      <p className="mb-4 text-sm text-ink-muted">
        Notifications raised by automations are delivered in-app today. A channel is only
        marked Ready once messages actually leave this system.
      </p>
      <div className="space-y-4">
        {INTEGRATIONS.map((i) => (
          <Card key={i.name}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold text-ink">{i.name}</h3>
                  <Badge tone={TONE[i.status]}>{i.status}</Badge>
                </div>
                <p className="mt-1 text-sm text-ink-muted">{i.desc}</p>
              </div>
              {i.href && (
                <Link
                  href={i.href}
                  className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline"
                >
                  Configure <ExternalLink size={14} />
                </Link>
              )}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function Step({
  n,
  title,
  done,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-4 py-4">
      <div
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-bold',
          done ? 'bg-emerald-100 text-emerald-700' : 'bg-clay-deep text-ink-muted',
        )}
      >
        {done ? <Check size={16} /> : n}
      </div>
      <div className="min-w-0 flex-1">
        <h4 className="font-semibold text-ink">{title}</h4>
        <div className="mt-1">{children}</div>
      </div>
    </div>
  );
}