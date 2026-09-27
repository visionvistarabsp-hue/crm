'use client';

import { useMemo, useState } from 'react';
import { useApi, fetcher } from '@/lib/fetcher';
import { Button, Card, CardHeader, cn, EmptyState, Input, PageHeader, Select, Spinner, Stat, Table } from '@/components/ui';
import { inr, monthLabel } from '@/lib/utils';

type Ach = {
  target: number | null;
  actual: number;
  attainment: number | null;
  gap: number;
  pct: number;
};

type Row = {
  userId: string;
  name: string;
  role: string;
  bookingValue: Ach;
  collection: Ach;
  leadCount: Ach;
  bookingCount: Ach;
  forecastValue: number;
};

type Report = {
  period: string;
  rows: Row[];
  totals: { bookingValue: Ach; collection: Ach; leadCount: Ach; bookingCount: Ach };
  forecast: {
    pipelineValue: number;
    expectedValue: number;
    openCount: number;
    staleCount: number;
    byStage: Array<{ status: string; count: number; budget: number; expected: number }>;
  };
  focus: Array<{ id: string; name: string; status: string; expectedValue: number; daysSinceTouch: number; stale: boolean }>;
};

const MONTHS = Array.from({ length: 12 }, (_, i) => {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - i + 1, 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
});

function Progress({ ach, money = true }: { ach: Ach; money?: boolean }) {
  if (ach.target === null) {
    return <span className="text-xs font-semibold text-ink-faint">Not set</span>;
  }
  const pct = Math.min(100, ach.pct);
  const tone = pct >= 100 ? 'bg-emerald-500' : pct >= 70 ? 'bg-primary-500' : pct >= 40 ? 'bg-accent-400' : 'bg-rose-400';
  return (
    <div className="min-w-[8rem]">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-bold tabular-nums text-ink">
          {money ? inr(ach.actual) : ach.actual}
        </span>
        <span className="text-[11px] font-semibold tabular-nums text-ink-faint">
          / {money ? inr(ach.target) : ach.target}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-clay-dark">
        <div className={cn(tone)} style={{ width: `${pct}%`, height: '100%' }} />
      </div>
    </div>
  );
}

export default function TargetsPage() {
  const [period, setPeriod] = useState(MONTHS[0]);
  const { data, error, loading, reload } = useApi<Report>(`/api/targets?period=${period}`);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedCount, setSavedCount] = useState<number | null>(null);

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const withTarget = useMemo(() => rows.filter((r) => r.bookingValue.target !== null), [rows]);

  const openEditor = () => {
    const d: Record<string, string> = {};
    for (const r of rows) if (r.bookingValue.target !== null) d[r.userId] = String(r.bookingValue.target);
    setDraft(d);
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const payload = Object.entries(draft)
        .filter(([, v]) => v.trim() !== '')
        .map(([userId, v]) => ({ userId, bookingValueTarget: Number(v) }));
      if (payload.length === 0) {
        setSaveError('Enter at least one booking-value target.');
        return;
      }
      const res = await fetcher<{ saved: number }>('/api/targets', {
        method: 'POST',
        body: JSON.stringify({ period, rows: payload }),
      });
      setSavedCount(res.saved);
      setEditing(false);
      reload();
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loading && !data) return <div className="flex justify-center p-10"><Spinner /></div>;
  if (error && !data) {
    return (
      <div className="rounded-2xl bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">
        {error.message}
      </div>
    );
  }
  if (!data) return <EmptyState title="No target data" />;

  return (
    <div>
      <PageHeader
        title="Targets & Forecast"
        subtitle={`${monthLabel(period)} · ${withTarget.length} of ${rows.length} have a target set`}
        action={
          <div className="flex items-center gap-2">
            <Select value={period} onChange={(e) => setPeriod(e.target.value)} className="!w-auto">
              {MONTHS.map((m) => (
                <option key={m} value={m}>{monthLabel(m)}</option>
              ))}
            </Select>
            <Button variant="secondary" onClick={openEditor}>Set targets</Button>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="Booking value"
          value={inr(data.totals.bookingValue.actual)}
          hint={
            data.totals.bookingValue.target === null
              ? 'No target set'
              : `${data.totals.bookingValue.attainment}% of ${inr(data.totals.bookingValue.target)}`
          }
          tone={data.totals.bookingValue.attainment !== null && data.totals.bookingValue.attainment >= 100 ? 'ring-2 ring-emerald-500/40' : undefined}
        />
        <Stat
          label="Collection"
          value={inr(data.totals.collection.actual)}
          hint={
            data.totals.collection.target === null
              ? 'No target set'
              : `${data.totals.collection.attainment}% of ${inr(data.totals.collection.target)}`
          }
        />
        <Stat label="Open pipeline" value={inr(data.forecast.pipelineValue)} hint={`${data.forecast.openCount} open leads`} />
        <Stat
          label="Weighted forecast"
          value={inr(data.forecast.expectedValue)}
          hint={data.forecast.staleCount > 0 ? `${data.forecast.staleCount} going cold` : 'All leads recently touched'}
        />
      </div>

      {savedCount !== null && (
        <div className="mt-4 rounded-2xl bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">
          Saved targets for {savedCount} {savedCount === 1 ? 'person' : 'people'}.
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader title="Team achievement" subtitle="Booking value against target" />
            {rows.length === 0 ? (
              <EmptyState title="No salespeople to show" />
            ) : (
              <Table head={['Salesperson', 'Booking value', 'Collection', 'Leads', 'Forecast', '']}>
                {rows.map((r) => (
                  <tr key={r.userId}>
                    <td className="px-5 py-4">
                      <p className="text-sm font-semibold text-ink">{r.name}</p>
                      <p className="text-[11px] capitalize text-ink-faint">{r.role.replace(/_/g, ' ').toLowerCase()}</p>
                    </td>
                    <td className="px-5 py-4"><Progress ach={r.bookingValue} /></td>
                    <td className="px-5 py-4"><Progress ach={r.collection} /></td>
                    <td className="px-5 py-4"><Progress ach={r.leadCount} money={false} /></td>
                    <td className="px-5 py-4">
                      <span className="text-sm font-semibold tabular-nums text-ink">{inr(r.forecastValue)}</span>
                    </td>
                    <td className="px-5 py-4 text-right">
                      {r.bookingValue.target !== null && r.bookingValue.gap > 0 ? (
                        <span className="text-xs font-bold text-rose-500">Short {inr(r.bookingValue.gap)}</span>
                      ) : r.bookingValue.target !== null ? (
                        <span className="text-xs font-bold text-emerald-600">Achieved</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Forecast by stage" subtitle="Where the open pipeline sits" />
            {data.forecast.byStage.length === 0 ? (
              <EmptyState title="No open leads" />
            ) : (
              <div className="space-y-2">
                {data.forecast.byStage.map((s) => (
                  <div key={s.status} className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate text-ink-muted">{s.status.replace(/_/g, ' ').toLowerCase()}</span>
                    <span className="shrink-0 text-right">
                      <span className="font-semibold tabular-nums text-ink">{s.count}</span>
                      <span className="ml-2 text-xs tabular-nums text-ink-faint">{inr(s.expected)}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="Work these next" subtitle="Coldest, highest-value open leads" />
            {data.focus.length === 0 ? (
              <EmptyState title="Nothing urgent" subtitle="Every open lead has been touched recently" />
            ) : (
              <div className="space-y-2">
                {data.focus.map((f) => (
                  <div key={f.id} className="flex items-center justify-between gap-2 rounded-xl bg-clay-deep px-3 py-2 shadow-clay-inset-sm">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-ink">{f.name || 'Unnamed lead'}</p>
                      <p className="text-[11px] text-ink-faint">
                        {f.status.replace(/_/g, ' ').toLowerCase()} · {f.daysSinceTouch}d idle
                      </p>
                    </div>
                    <span
                      className={cn(
                        'shrink-0 text-xs font-bold tabular-nums',
                        f.stale ? 'text-rose-500' : 'text-ink-muted',
                      )}
                    >
                      {inr(f.expectedValue)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4 backdrop-blur-sm">
          <div className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-3xl bg-surface p-6 shadow-pop">
            <h2 className="text-lg font-bold text-ink">Booking value targets · {monthLabel(period)}</h2>
            <p className="mt-1 text-xs text-ink-muted">
              Rupees. Leave blank to leave a person without a target.
            </p>
            <div className="mt-4 space-y-3">
              {rows.map((r) => (
                <div key={r.userId} className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink">{r.name}</p>
                    <p className="truncate text-[11px] capitalize text-ink-faint">{r.role.replace(/_/g, ' ').toLowerCase()}</p>
                  </div>
                  <Input
                    type="number"
                    inputMode="numeric"
                    placeholder={r.bookingValue.target !== null ? String(r.bookingValue.target) : 'none'}
                    value={draft[r.userId] ?? ''}
                    onChange={(e) => setDraft((d) => ({ ...d, [r.userId]: e.target.value }))}
                    className="!w-36 text-right"
                  />
                </div>
              ))}
            </div>
            {saveError && (
              <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">{saveError}</p>
            )}
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setEditing(false)}>Cancel</Button>
              <Button onClick={save} loading={saving}>Save targets</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
