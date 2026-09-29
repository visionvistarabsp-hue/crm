'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Phone, Plus } from 'lucide-react';
import { Suspense, useState } from 'react';
import { Button, EmptyState, Input, PageHeader, Spinner, StatusBadge } from '@/components/ui';
import { ApiErrorView, useApi } from '@/lib/fetcher';

type Lead = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  status: string;
  source: string | null;
  ownerName: string | null;
  createdAt: string;
};

type Payload = { items: Lead[] };

const ago = (iso: string) => {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
};

export default function MyLeadsPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-10"><Spinner /></div>}>
      <MyLeads />
    </Suspense>
  );
}

function MyLeads() {
  const params = useSearchParams();
  const highlight = params.get('highlight');
  const [q, setQ] = useState('');
  const { data, error, loading, reload } = useApi<Payload>(`/api/easy/leads?q=${encodeURIComponent(q)}`, { deps: [q] });

  return (
    <div className="mx-auto max-w-lg">
      <PageHeader
        title="Leads"
        subtitle={data ? `${data.items.length} shown` : 'Everyone assigned to you'}
        action={
          <Link href="/new-lead" className="btn-primary">
            <Plus size={16} /> Add
          </Link>
        }
      />

      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or phone" className="mb-4" />

      <ApiErrorView error={error} onRetry={reload} />
      {loading && !data && (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      )}

      {data && data.items.length === 0 && (
        <EmptyState
          title={q ? 'No matches' : 'No leads yet'}
          subtitle={q ? 'Try a different name or number.' : 'Add your first lead and it will show up here.'}
          action={
            !q ? (
              <Link href="/new-lead" className="btn-primary">
                <Plus size={16} /> New lead
              </Link>
            ) : undefined
          }
        />
      )}

      <div className="space-y-3">
        {data?.items.map((l) => {
          const digits = (l.phone ?? '').replace(/\D/g, '');
          return (
            <div
              key={l.id}
              className={`rounded-2xl bg-surface p-3.5 shadow-clay-sm ${l.id === highlight ? 'ring-2 ring-primary-500' : ''}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-ink">{l.name}</p>
                  <p className="truncate text-[11px] font-medium text-ink-faint">
                    {l.phone ?? l.email ?? 'No contact'} · {ago(l.createdAt)}
                  </p>
                </div>
                <StatusBadge status={l.status} />
              </div>
              <div className="mt-2.5 flex items-center gap-2">
                {l.phone && (
                  <>
                    <a href={`tel:${l.phone}`} className="btn-secondary !py-1 text-xs">
                      <Phone size={13} /> Call
                    </a>
                    <a href={`https://wa.me/${digits}`} target="_blank" rel="noreferrer" className="btn-secondary !py-1 text-xs">
                      WhatsApp
                    </a>
                  </>
                )}
                <Link href={`/leads/${l.id}`} className="btn-ghost !py-1 ml-auto text-xs">
                  Open
                </Link>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
