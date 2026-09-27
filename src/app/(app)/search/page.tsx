'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useApi } from '@/lib/useApi';
import { ApiErrorView } from '@/lib/fetcher';
import { Badge, EmptyState, Input, PageHeader, Spinner, StatusBadge } from '@/components/ui';

type Results = {
  leads?: Array<{ id: string; name: string; leadNo: string; status: string; ownerName?: string | null }>;
  customers?: Array<{ id: string; name: string; phone: string }>;
  bookings?: Array<{ id: string; bookingNo: string; status: string }>;
  projects?: Array<{ id: string; name: string; location?: string | null }>;
  units?: Array<{ id: string; unitNo: string; status: string }>;
};

export default function SearchPage() {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [scope, setScope] = useState('all');
  const url = useMemo(() => {
    if (!debounced) return null;
    return `/api/search?q=${encodeURIComponent(debounced)}&scope=${scope}`;
  }, [debounced, scope]);
  const { data, error, loading } = useApi<Results>(url, { deps: [debounced, scope] });

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Search" subtitle="Leads, customers, bookings, projects and units" />
      <div className="card mb-4 flex flex-col gap-3 p-4 sm:flex-row">
        <Input
          autoFocus
          placeholder="Type to search — name, phone, email, unit no…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setTimeout(() => setDebounced(e.target.value), 350);
          }}
        />
        <select className="input !w-auto" value={scope} onChange={(e) => setScope(e.target.value)}>
          {['all', 'leads', 'customers', 'bookings', 'projects', 'units'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {loading && <div className="flex justify-center p-8"><Spinner /></div>}
      <ApiErrorView error={error} />

      {data && <div className="space-y-6">
        {scope === 'all' || scope === 'leads' ? (
          <Group title="Leads">
            {data.leads?.map((l) => (
              <Link key={l.id} href={`/leads/${l.id}`} className="flex items-center justify-between rounded-2xl bg-surface p-3 shadow-clay-sm transition-all hover:-translate-y-0.5 hover:shadow-clay">
                <div><p className="font-medium text-ink">{l.name}</p><p className="text-xs text-ink-faint">{l.leadNo} · {l.ownerName ?? 'unassigned'}</p></div>
                <StatusBadge status={l.status} />
              </Link>
            ))}
            {scope === 'leads' && !data.leads?.length && <EmptyState title="No leads found" />}
          </Group>
        ) : null}
        {scope === 'all' || scope === 'customers' ? (
          <Group title="Customers">
            {data.customers?.map((c) => (
              <div key={c.id} className="flex items-center justify-between rounded-2xl bg-surface p-3 shadow-clay-sm">
                <p className="font-medium text-ink">{c.name}</p>
                <p className="text-sm text-ink-muted">{c.phone}</p>
              </div>
            ))}
            {scope === 'customers' && !data.customers?.length && <EmptyState title="No customers found" />}
          </Group>
        ) : null}
        {scope === 'all' || scope === 'bookings' ? (
          <Group title="Bookings">
            {data.bookings?.map((b) => (
              <Link key={b.id} href={`/bookings/${b.id}`} className="flex items-center justify-between rounded-2xl bg-surface p-3 shadow-clay-sm transition-all hover:-translate-y-0.5 hover:shadow-clay">
                <p className="font-medium text-ink">{b.bookingNo}</p>
                <StatusBadge status={b.status} />
              </Link>
            ))}
            {scope === 'bookings' && !data.bookings?.length && <EmptyState title="No bookings found" />}
          </Group>
        ) : null}
        {scope === 'all' || scope === 'projects' ? (
          <Group title="Projects">
            {data.projects?.map((p) => (
              <Link key={p.id} href={`/projects`} className="flex items-center justify-between rounded-2xl bg-surface p-3 shadow-clay-sm transition-all hover:-translate-y-0.5 hover:shadow-clay">
                <p className="font-medium text-ink">{p.name}</p>
                <p className="text-sm text-ink-muted">{p.location ?? ''}</p>
              </Link>
            ))}
            {scope === 'projects' && !data.projects?.length && <EmptyState title="No projects found" />}
          </Group>
        ) : null}
        {scope === 'all' || scope === 'units' ? (
          <Group title="Units">
            {data.units?.map((u) => (
              <div key={u.id} className="flex items-center justify-between rounded-2xl bg-surface p-3 shadow-clay-sm">
                <p className="font-medium text-ink">{u.unitNo}</p>
                <StatusBadge status={u.status} />
              </div>
            ))}
            {scope === 'units' && !data.units?.length && <EmptyState title="No units found" />}
          </Group>
        ) : null}
        {scope === 'all' && !data.leads?.length && !data.customers?.length && !data.bookings?.length && !data.projects?.length && !data.units?.length && (
          <EmptyState title="No results" subtitle="Try a different search term." />
        )}
      </div>}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-ink-faint">{title}</h3>
      <div className="space-y-2">{children}</div>
    </section>
  );
}