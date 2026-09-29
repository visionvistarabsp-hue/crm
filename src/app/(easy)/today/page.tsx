'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CalendarCheck, IndianRupee, Phone, StickyNote } from 'lucide-react';
import { useState } from 'react';
import { Button, Card, CardHeader, EmptyState, PageHeader, Spinner } from '@/components/ui';
import { ApiErrorView, fetcher, useApi } from '@/lib/fetcher';

type Followup = {
  id: string;
  type: string;
  scheduledAt: string;
  notes: string | null;
  customerName: string | null;
  leadName: string | null;
  customerPhone: string | null;
  leadPhone: string | null;
  isOverdue: boolean;
};

type Due = {
  id: string;
  customerName: string;
  customerPhone: string | null;
  outstanding: number;
  dueDate: string;
  daysOverdue: number;
};

type Today = { followups: Followup[]; dues: Due[]; total: number };

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

function ContactLinks({ phone }: { phone: string | null }) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  return (
    <div className="flex gap-2">
      <a href={`tel:${phone}`} className="btn-secondary !py-1 text-xs">
        <Phone size={13} /> Call
      </a>
      <a href={`https://wa.me/${digits}`} target="_blank" rel="noreferrer" className="btn-secondary !py-1 text-xs">
        WhatsApp
      </a>
    </div>
  );
}

export default function TodayPage() {
  const { data, error, loading, reload } = useApi<Today>('/api/easy/today', { refresh: 60000 });
  const [busy, setBusy] = useState<string | null>(null);
  const router = useRouter();

  const complete = async (id: string) => {
    setBusy(id);
    try {
      await fetcher(`/api/followups/${id}`, { method: 'POST', body: JSON.stringify({}) });
      await reload();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-lg">
      <PageHeader title="Today" subtitle={data ? `${data.total} item${data.total === 1 ? '' : 's'} waiting` : 'Your list'} />

      <ApiErrorView error={error} onRetry={reload} />
      {loading && !data && (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      )}

      {data && data.total === 0 && (
        <EmptyState title="All clear" subtitle="No follow-ups or payments due. Nothing to do right now." />
      )}

      {data && data.followups.length > 0 && (
        <Card className="mb-4">
          <CardHeader title="Follow-ups" subtitle={`${data.followups.length} to complete`} />
          <div className="space-y-3">
            {data.followups.map((f) => (
              <div key={f.id} className="rounded-2xl bg-surface p-3 shadow-clay-sm">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-ink">{f.customerName ?? f.leadName ?? 'Unknown'}</p>
                    <p className="text-[11px] font-medium text-ink-faint">
                      {f.type.replace(/_/g, ' ')} · {when(f.scheduledAt)}
                    </p>
                  </div>
                  {f.isOverdue && <span className="shrink-0 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold text-rose-700">Overdue</span>}
                </div>
                {f.notes && (
                  <p className="mt-2 flex items-start gap-1.5 text-xs text-ink-muted">
                    <StickyNote size={13} className="mt-0.5 shrink-0" />
                    {f.notes}
                  </p>
                )}
                <div className="mt-3 flex items-center gap-2">
                  <Button className="!py-1.5 text-xs" loading={busy === f.id} onClick={() => complete(f.id)}>
                    Mark done
                  </Button>
                  <ContactLinks phone={f.customerPhone ?? f.leadPhone} />
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {data && data.dues.length > 0 && (
        <Card>
          <CardHeader title="Payments due" subtitle={`${data.dues.length} pending`} />
          <div className="space-y-3">
            {data.dues.map((d) => (
              <div key={d.id} className="rounded-2xl bg-surface p-3 shadow-clay-sm">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-ink">{d.customerName}</p>
                    <p className="text-[11px] font-medium text-ink-faint">
                      Due {when(d.dueDate)}
                      {d.daysOverdue > 0 && ` · ${d.daysOverdue}d late`}
                    </p>
                  </div>
                  <span className="shrink-0 text-sm font-black text-primary-700">₹{d.outstanding.toLocaleString('en-IN')}</span>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <Button className="!py-1.5 text-xs" onClick={() => router.push(`/new-payment?dueId=${d.id}`)}>
                    <IndianRupee size={13} /> Collect
                  </Button>
                  <ContactLinks phone={d.customerPhone} />
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {data && data.total === 0 && (
        <div className="mt-4 text-center">
          <Link href="/home" className="btn-secondary">
            <CalendarCheck size={16} /> Back home
          </Link>
        </div>
      )}
    </div>
  );
}
