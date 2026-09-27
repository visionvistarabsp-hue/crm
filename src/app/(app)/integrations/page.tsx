'use client';

import { Card, CardHeader, PageHeader, Badge } from '@/components/ui';

/**
 * Integration status is reported honestly: a channel only counts as Ready when
 * the app actually has a working path for it. "In-app" means notifications are
 * written to the notifications table and shown in the bell menu.
 */
const INTEGRATIONS: Array<{
  name: string;
  status: 'Ready' | 'In-app only' | 'Not built';
  desc: string;
}> = [
  {
    name: 'Meta (Facebook/Instagram) Ads',
    status: 'Ready',
    desc: 'Incoming leads land via webhook at POST /api/webhooks/leads, with a Meta-specific route for lead ads.',
  },
  {
    name: 'WhatsApp Business',
    status: 'Not built',
    desc: 'Not connected. Follow-ups can be logged as a WhatsApp touch, but no messages are sent from this app.',
  },
  {
    name: 'Email (SMTP)',
    status: 'Not built',
    desc: 'Not connected. Notifications are stored in-app and surfaced in the bell menu; nothing is emailed.',
  },
  {
    name: 'Slack',
    status: 'Not built',
    desc: 'Planned. No team alerts are sent out of the app yet.',
  },
];

const TONE: Record<string, 'green' | 'amber' | 'gray'> = {
  Ready: 'green',
  'In-app only': 'amber',
  'Not built': 'gray',
};

export default function IntegrationsPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Integrations"
        subtitle="External lead sources and notification channels"
      />
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
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
