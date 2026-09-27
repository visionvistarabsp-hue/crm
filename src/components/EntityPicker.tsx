'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Search, UserRound, UsersRound, X } from 'lucide-react';
import { cn, Spinner, StatusBadge } from '@/components/ui';
import { fetcher } from '@/lib/fetcher';

export type Picked = { kind: 'lead' | 'customer'; id: string; label: string; meta?: string } | null;

type LeadHit = { id: string; name: string; leadNo: string; status: string; ownerName?: string | null };
type CustomerHit = { id: string; name: string; phone: string };

/** `datetime-local` needs a local-time string, not an ISO/UTC one. */
export function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Searchable lead/customer selector.
 *
 * Follow-ups and meetings must attach to a lead or a customer server-side, and
 * the ids are opaque — so the only usable way to set one is to look it up by
 * name. Replaces the old "paste the lead ID" input.
 */
export default function EntityPicker({
  value,
  onChange,
  label = 'Lead or customer',
  hint,
  autoFocus,
}: {
  value: Picked;
  onChange: (v: Picked) => void;
  label?: string;
  hint?: string;
  autoFocus?: boolean;
}) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [hits, setHits] = useState<{ leads: LeadHit[]; customers: CustomerHit[] }>({ leads: [], customers: [] });
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    if (value || debounced.length < 2) {
      setHits({ leads: [], customers: [] });
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetcher<{ leads?: LeadHit[]; customers?: CustomerHit[] }>(
      `/api/search?q=${encodeURIComponent(debounced)}&scope=all&limit=6`,
    )
      .then((d) => {
        if (cancelled) return;
        setHits({ leads: d.leads ?? [], customers: d.customers ?? [] });
        setOpen(true);
      })
      .catch(() => {
        if (!cancelled) setHits({ leads: [], customers: [] });
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [debounced, value]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const pick = (p: NonNullable<Picked>) => {
    onChange(p);
    setQ('');
    setDebounced('');
    setOpen(false);
  };

  const clear = () => {
    onChange(null);
    setQ('');
    setDebounced('');
  };

  const total = hits.leads.length + hits.customers.length;

  return (
    <div>
      <span className="mb-1.5 block text-sm font-semibold text-ink-muted">
        {label} <span className="text-rose-500">*</span>
      </span>

      {value ? (
        <div className="flex items-center gap-3 rounded-xl bg-surface px-4 py-3 shadow-clay-inset-sm">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-100 text-primary-700">
            {value.kind === 'lead' ? <UsersRound size={18} /> : <UserRound size={18} />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold text-ink">{value.label}</p>
            <p className="truncate text-xs text-ink-faint">{value.meta ?? value.kind}</p>
          </div>
          <button type="button" onClick={clear} className="chip-clay !rounded-full !p-2" aria-label="Clear selection">
            <X size={16} />
          </button>
        </div>
      ) : (
        <div ref={boxRef} className="relative">
          <div className="relative">
            <Search size={18} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-ink-faint" />
            <InputWithLoader
              value={q}
              onChange={setQ}
              loading={loading}
              autoFocus={autoFocus}
              placeholder="Search by name, phone or lead no…"
            />
          </div>

          {open && (
            <div className="absolute z-30 mt-2 max-h-72 w-full overflow-y-auto rounded-2xl bg-canvas p-2 shadow-pop animate-pop-in">
              {total === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-ink-faint">
                  {debounced.length < 2 ? 'Type at least 2 characters.' : 'No matches found.'}
                </p>
              ) : (
                <>
                  {hits.leads.length > 0 && (
                    <p className="section-label !px-3 !py-1.5">Leads</p>
                  )}
                  {hits.leads.map((l) => (
                    <button
                      key={l.id}
                      type="button"
                      onClick={() => pick({ kind: 'lead', id: l.id, label: l.name, meta: `${l.leadNo} · ${l.ownerName ?? 'unassigned'}` })}
                      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-clay-deep"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-ink">{l.name}</p>
                        <p className="truncate text-xs text-ink-faint">{l.leadNo} · {l.ownerName ?? 'unassigned'}</p>
                      </div>
                      <StatusBadge status={l.status} />
                    </button>
                  ))}
                  {hits.customers.length > 0 && (
                    <p className="section-label !px-3 !py-1.5">Customers</p>
                  )}
                  {hits.customers.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => pick({ kind: 'customer', id: c.id, label: c.name, meta: c.phone || 'customer' })}
                      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-clay-deep"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-ink">{c.name}</p>
                        <p className="truncate text-xs text-ink-faint">{c.phone || 'customer'}</p>
                      </div>
                      <span className="chip bg-emerald-100 text-emerald-800">Customer</span>
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {hint && <span className="mt-1.5 block text-xs text-ink-faint">{hint}</span>}
    </div>
  );
}

function InputWithLoader({
  value,
  onChange,
  loading,
  autoFocus,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  loading: boolean;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  return (
    <div className="relative">
      <input
        className={cn('input !pl-12', loading && 'pr-12')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
        placeholder={placeholder}
        autoComplete="off"
      />
      {loading && <Spinner className="absolute right-4 top-1/2 -translate-y-1/2 text-ink-faint" />}
    </div>
  );
}

/** Compact read-only display of an already-picked entity (e.g. in a list row). */
export function PickedChip({ picked }: { picked: NonNullable<Picked> }) {
  return (
    <span className="chip bg-primary-100 text-primary-800">
      <Check size={14} />
      {picked.label}
    </span>
  );
}
