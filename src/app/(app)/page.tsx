'use client';

import Link from 'next/link';
import { useApi } from '@/lib/useApi';
import { ApiErrorView } from '@/lib/fetcher';
import { Card, CardHeader, EmptyState, Money, PageHeader, Spinner, Stat, StatusBadge, Table } from '@/components/ui';
import { monthLabel } from '@/lib/utils';

type Dashboard = {
  leads: { total: number; new: number; followUp: number; meeting: number; overdueFollowups: number };
  bookings: { total: number; saleValue: number; newThisMonth: number };
  collections: number;
  customers: number;
  visits: { scheduled: number; completed: number; total: number };
  commissions: { entitlements: number };
  conversion: number;
  // The service buckets by `month` (YYYY-MM); there is no `label` field.
  trend: Array<{ month: string; leads: number; bookings: number; saleValue: number; collected: number }>;
};

export default function DashboardPage() {
  const { data, error, loading, reload } = useApi<Dashboard>('/api/dashboard', { refresh: 60000 });

  if (loading && !data) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-6 w-6 text-primary-600" />
      </div>
    );
  }
  if (error && !data) return <ApiErrorView error={error} onRetry={reload} />;
  if (!data) return <EmptyState title="No data yet" />;

  // Scale the bars against the peak once, rather than re-scanning the series
  // for every row.
  const maxLeads = Math.max(1, ...data.trend.map((x) => x.leads));
  const maxBookings = Math.max(1, ...data.trend.map((x) => x.bookings));

  return (
    <div>
      <PageHeader title="Dashboard" subtitle={`Last refreshed ${new Date().toLocaleTimeString()}`} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Active leads" value={<Money value={data.leads.total} />} hint={`${data.leads.new} new · ${data.leads.followUp} follow-up left`} />
        <Stat label="Bookings" value={<Money value={data.bookings.total} />} hint={`${data.bookings.newThisMonth ?? 0} this month`} />
        <Stat label="Sale value" value={`₹ ${new Intl.NumberFormat('en-IN').format(data.bookings.saleValue)}`} hint={`Collection ${new Intl.NumberFormat('en-IN').format(data.collections)}`} />
        <Stat label="Conversion" value={`${data.conversion}%`} hint={`${data.customers} customers · ${data.leads.meeting} in negotiation`} />
        <Stat label="Expected commissions" value={<Money value={data.commissions.entitlements} />} hint="PAYABLE entitlements" />
        <Stat label="Visits" value={<Money value={data.visits.total} />} hint={`${data.visits.completed} completed`} />
        <Stat label="Overdue follow-ups" value={<Money value={data.leads.overdueFollowups} />} hint="Requires attention" tone={data.leads.overdueFollowups > 0 ? 'red' : undefined} />
        <Stat label="Customers" value={<Money value={data.customers} />} hint="Converted from leads" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="6-month pipeline" subtitle="Monthly lead & booking count" action={<Link href="/reports" className="text-sm text-primary-700 hover:underline">Reports →</Link>} />
          {data.trend.length === 0 ? (
            <EmptyState title="No trend data" />
          ) : (
            <div className="space-y-2">
              {data.trend.map((t) => (
                <div key={t.month} className="flex items-center gap-3 text-sm">
                  <span className="w-16 shrink-0 truncate text-ink-muted">{monthLabel(t.month)}</span>
                  <div className="flex h-6 flex-1 items-center gap-1">
                    <div title={`${t.leads} leads`} className="h-4 rounded bg-primary-500" style={{ width: `${Math.max(4, (t.leads / maxLeads) * 100)}%` }} />
                    <div title={`${t.bookings} bookings`} className="h-4 rounded bg-accent" style={{ width: `${Math.max(4, (t.bookings / maxBookings) * 100)}%` }} />
                  </div>
                  <span className="w-24 shrink-0 text-right tabular-nums text-ink-faint">
                    {t.leads} / {t.bookings}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Quick actions" />
          <div className="grid grid-cols-2 gap-3">
            <ActionTile href="/leads/new" label="Add lead" desc="Capture a new prospect" />
            <ActionTile href="/bookings/new" label="New booking" desc="Book a unit" />
            <ActionTile href="/followups/new" label="Schedule follow-up" desc="Plan outreach" />
            <ActionTile href="/meetings/new" label="Schedule meeting" desc="Book a site visit" />
          </div>
        </Card>
      </div>
    </div>
  );
}

function ActionTile({ href, label, desc }: { href: string; label: string; desc: string }) {
  return (
    <Link href={href} className="row-span-1 rounded-2xl bg-surface p-4 shadow-clay-sm transition-all hover:-translate-y-0.5 hover:shadow-clay">
      <p className="text-sm font-semibold text-primary-800">{label}</p>
      <p className="mt-0.5 text-xs text-ink-muted">{desc}</p>
    </Link>
  );
}