'use client';

import Link from 'next/link';
import { ArrowRight, CalendarCheck, IndianRupee, TrendingUp, UserPlus, UsersRound, Wallet } from 'lucide-react';
import { ApiErrorView, useApi } from '@/lib/fetcher';
import { Card, CardHeader, PageHeader, Spinner, Stat } from '@/components/ui';

type Summary = {
  name: string;
  today: { followups: number; payments: number; total: number };
  newLeads: number;
  activeLeads: number;
  money: { outstanding: number; collectedThisMonth: number };
};

function inr(n: number): string {
  return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

const TILES = [
  { href: '/today', label: 'Today', icon: CalendarCheck, hint: 'Follow-ups & dues' },
  { href: '/new-lead', label: 'New Lead', icon: UserPlus, hint: 'Add in 20 seconds' },
  { href: '/my-leads', label: 'Leads', icon: UsersRound, hint: 'Everyone I own' },
  { href: '/new-payment', label: 'Money', icon: IndianRupee, hint: 'Collect a payment' },
];

export default function EasyHomePage() {
  const { data, error, loading, reload } = useApi<Summary>('/api/easy/summary', { refresh: 60000 });

  return (
    <div className="mx-auto max-w-lg">
      <PageHeader title="Home" subtitle="Everything that needs you today" />

      <ApiErrorView error={error} onRetry={reload} />

      {loading && !data && (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      )}

      {data && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3">
            {TILES.map((t) => {
              const Icon = t.icon;
              let value: number | null = null;
              if (t.href === '/today') value = data.today.total;
              if (t.href === '/my-leads') value = data.newLeads;
              if (t.href === '/new-payment') value = data.today.payments;

              return (
                <Link
                  key={t.href}
                  href={t.href}
                  className="flex flex-col gap-2 rounded-3xl bg-surface p-4 shadow-clay-sm transition active:shadow-clay-inset-sm"
                >
                  <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-accent-300 text-primary-900 shadow-clay-xs">
                    <Icon size={22} />
                  </span>
                  {value !== null && value > 0 && (
                    <span className="text-2xl font-black leading-none text-primary-700">{value}</span>
                  )}
                  <span className="text-sm font-bold text-ink">{t.label}</span>
                  <span className="text-[11px] font-medium text-ink-faint">{t.hint}</span>
                </Link>
              );
            })}
          </div>

          <Card className="mb-4">
            <CardHeader title="Today" subtitle={`${data.today.followups} follow-ups · ${data.today.payments} payments`} />
            <div className="flex items-center justify-between">
              <p className="text-sm text-ink-muted">
                {data.today.total === 0 ? 'Nothing pending. Enjoy the quiet.' : 'You have work waiting.'}
              </p>
              <Link href="/today" className="btn-secondary !py-1.5">
                Open <ArrowRight size={14} />
              </Link>
            </div>
          </Card>

          <Card>
            <CardHeader title="Money" subtitle="Your collection position" />
            <div className="grid grid-cols-2 gap-3">
              <Stat label="Outstanding" value={inr(data.money.outstanding)} hint="Unpaid dues" />
              <Stat label="Collected" value={inr(data.money.collectedThisMonth)} hint="This month" />
            </div>
            <div className="mt-4 flex items-center justify-between rounded-2xl bg-clay-deep px-4 py-3 shadow-clay-inset-sm">
              <span className="flex items-center gap-2 text-sm font-semibold text-ink-muted">
                <TrendingUp size={16} /> Active leads
              </span>
              <span className="text-lg font-black text-ink">{data.activeLeads}</span>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
