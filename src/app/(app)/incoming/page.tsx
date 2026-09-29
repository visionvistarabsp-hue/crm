'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, RotateCw } from 'lucide-react';
import { Badge, Button, Card, CardHeader, PageHeader, Spinner } from '@/components/ui';
import { ApiErrorView, fetcher, useApi } from '@/lib/fetcher';

type Status = 'RECEIVED' | 'CREATED' | 'DUPLICATE' | 'ERROR' | 'IGNORED';

type Receipt = {
  id: string;
  provider: string;
  status: Status;
  leadId: string | null;
  error: string | null;
  receivedAt: string;
  rawPayload: Record<string, unknown>;
};

type Payload = {
  counts: Record<Status, number>;
  items: Receipt[];
  filtered: { status: Status | null; provider: string | null; limit: number };
};

type RetryResult = { ok: boolean; id: string; retried: boolean; reused: boolean; status: Status };

const STATUSES: Status[] = ['RECEIVED', 'CREATED', 'DUPLICATE', 'ERROR', 'IGNORED'];

type Tone = 'green' | 'amber' | 'gray' | 'red' | 'blue' | 'yellow' | 'purple';

const TONE: Record<Status, Tone> = {
  RECEIVED: 'amber',
  CREATED: 'green',
  DUPLICATE: 'gray',
  ERROR: 'red',
  IGNORED: 'gray',
};

const STATUS_NOTE: Record<Status, string> = {
  RECEIVED: 'queued for sync',
  CREATED: 'lead created',
  DUPLICATE: 'matched existing lead',
  ERROR: 'needs operator attention',
  IGNORED: 'discarded',
};

export default function IncomingPage() {
  const { data, error, loading, reload } = useApi<Payload>('/api/incoming?limit=200', { refresh: 20_000 });
  const [filter, setFilter] = useState<Status | 'ALL'>('ALL');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [retryNote, setRetryNote] = useState<Record<string, string>>({});

  const rows = filter === 'ALL' ? (data?.items ?? []) : (data?.items ?? []).filter((r) => r.status === filter);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const retry = async (receipt: Receipt) => {
    setBusy(receipt.id);
    setRetryNote((prev) => ({ ...prev, [receipt.id]: '' }));
    try {
      const result = await fetcher<RetryResult>(`/api/incoming/${receipt.id}/retry`, { method: 'POST' });
      setRetryNote((prev) => ({
        ...prev,
        [receipt.id]: result.retried
          ? result.reused
            ? 'revived the failed job; sync rescheduled'
            : 're-enqueued for sync'
          : result.status === 'RECEIVED'
            ? 'already in the queue'
            : `already resolved (${result.status})`,
      }));
      await reload();
    } catch (err) {
      setRetryNote((prev) => ({ ...prev, [receipt.id]: `failed: ${(err as Error).message}` }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Incoming webhook receipts"
        subtitle="Every provider delivery, and what the sync did with it — the queue&rsquo;s audit log"
      />

      <ApiErrorView error={error} onRetry={reload} />

      {loading && !data && (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      )}

      {data && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-1.5">
            <FilterPill
              label="All"
              count={data?.items.length ?? 0}
              active={filter === 'ALL'}
              onClick={() => setFilter('ALL')}
            />
            {STATUSES.map((status) => (
              <FilterPill
                key={status}
                label={status}
                count={data.counts[status] ?? 0}
                active={filter === status}
                onClick={() => setFilter(status)}
                tone={TONE[status]}
              />
            ))}
          </div>

          <Card>
            <CardHeader
              title={filter === 'ALL' ? 'Recent receipts (up to 200)' : `${filter} receipts`}
              subtitle={STATUS_NOTE[filter === 'ALL' ? 'RECEIVED' : filter]}
            />
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-black/5 text-[11px] uppercase tracking-wide text-ink-faint">
                    <th className="px-4 py-2 font-bold">Received</th>
                    <th className="px-4 py-2 font-bold">Receipt</th>
                    <th className="px-4 py-2 font-bold">Provider</th>
                    <th className="px-4 py-2 font-bold">Status</th>
                    <th className="px-4 py-2 font-bold">Lead</th>
                    <th className="px-4 py-2 font-bold">Error</th>
                    <th className="px-4 py-2 text-right font-bold">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-xs text-ink-faint">
                        No receipts{filter === 'ALL' ? '' : ` with status ${filter}`}
                      </td>
                    </tr>
                  )}
                  {rows.map((receipt) => (
                    <ReceiptRow
                      key={receipt.id}
                      receipt={receipt}
                      expanded={expanded.has(receipt.id)}
                      busy={busy === receipt.id}
                      note={retryNote[receipt.id]}
                      onToggle={() => toggle(receipt.id)}
                      onRetry={() => void retry(receipt)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function FilterPill({
  label,
  count,
  active,
  onClick,
  tone,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  tone?: Tone;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold transition-colors ${
        active ? 'bg-primary-600 text-white shadow' : 'bg-white text-ink-muted hover:bg-black/5'
      }`}
    >
      {label}
      <span className={active ? 'text-white/80' : 'text-ink-faint'}>{count}</span>
      {tone && !active && <span className="inline-block h-2 w-2 rounded-full bg-current opacity-40" />}
    </button>
  );
}

function ReceiptRow({
  receipt,
  expanded,
  busy,
  note,
  onToggle,
  onRetry,
}: {
  receipt: Receipt;
  expanded: boolean;
  busy: boolean;
  note?: string;
  onToggle: () => void;
  onRetry: () => void;
}) {
  return (
    <>
      <tr className="border-b border-black/5 align-top">
        <td className="whitespace-nowrap px-4 py-2.5 text-xs text-ink-muted">
          {new Date(receipt.receivedAt).toLocaleString()}
        </td>
        <td className="px-4 py-2.5">
          <button onClick={onToggle} className="flex items-center gap-1 font-mono text-xs text-primary-600 hover:underline">
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {receipt.id.slice(0, 8)}
          </button>
        </td>
        <td className="px-4 py-2.5 text-xs">{receipt.provider}</td>
        <td className="px-4 py-2.5">
          <Badge tone={TONE[receipt.status]}>{receipt.status}</Badge>
        </td>
        <td className="px-4 py-2.5">
          {receipt.leadId ? (
            <a
              href={`/leads/${receipt.leadId}`}
              className="font-mono text-xs text-primary-600 hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {receipt.leadId.slice(0, 8)}
            </a>
          ) : (
            <span className="text-xs text-ink-faint">—</span>
          )}
        </td>
        <td className="max-w-[220px] px-4 py-2.5">
          {receipt.error ? (
            <span className="block truncate text-xs text-rose-700" title={receipt.error}>
              {receipt.error}
            </span>
          ) : (
            <span className="text-xs text-ink-faint">—</span>
          )}
        </td>
        <td className="whitespace-nowrap px-4 py-2.5 text-right">
          {receipt.status === 'RECEIVED' ? (
            <Button variant="secondary" className="!py-1 text-xs" loading={busy} onClick={onRetry}>
              <RotateCw size={12} /> Retry
            </Button>
          ) : (
            <span className="text-xs text-ink-faint">done</span>
          )}
        </td>
      </tr>
      {note && (
        <tr className="border-b border-black/5 bg-accent-50/50">
          <td colSpan={7} className="px-4 py-1.5 text-xs text-primary-800">
            {note}
          </td>
        </tr>
      )}
      {expanded && (
        <tr className="border-b border-black/5">
          <td colSpan={7} className="px-4 py-3">
            <pre className="max-h-64 overflow-auto rounded-xl bg-slate-50 p-3 font-mono text-[11px] leading-relaxed text-slate-700">
              {JSON.stringify(receipt.rawPayload, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}