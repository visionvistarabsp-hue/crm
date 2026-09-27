'use client';

import { useMemo, useState } from 'react';
import { useApi } from '@/lib/useApi';
import { ApiErrorView } from '@/lib/fetcher';
import { Card, CardHeader, EmptyState, PageHeader, Spinner, Table } from '@/components/ui';

type SalesReport = {
  summary: { count: number; value: number; cancelled: number; cancellationRate: number };
  byUser: Array<{ name: string | null; count: number; value: string }>;
  byProject: Array<{ name: string | null; count: number; value: string }>;
  byStatus: Array<{ status: string; count: number; value: string }>;
  bySource: Array<{ source: string; count: number }>;
};

type CancellationReport = {
  total: number; totalRefund: number;
  byCategory: Array<{ reasonCategory: string | null; status: string; count: number; amount: string }>;
};

export default function ReportsPage() {
  const [year, setYear] = useState('all');
  const [projectId, setProjectId] = useState('');
  const sp = useMemo(() => {
    const p = new URLSearchParams();
    if (year !== 'all') p.set('from', `${year}-01-01`);
    if (projectId) p.set('projectId', projectId);
    return p.toString();
  }, [year, projectId]);
  const sales = useApi<SalesReport>(`/api/reports/sales${sp ? `?${sp}` : ''}`, { deps: [sp] });
  const cancels = useApi<CancellationReport>(`/api/reports/cancellations${sp ? `?${sp}` : ''}`, { deps: [sp] });

  return (
    <div>
      <PageHeader title="Reports" subtitle="Sales and cancellation analytics" />
      <div className="card mb-6 flex flex-wrap items-center gap-3 p-4">
        <button className={year === 'all' ? 'btn-primary !py-1.5' : 'btn-secondary !py-1.5'} onClick={() => setYear('all')}>All time</button>
        {['2024', '2025', '2026'].map((y) => (
          <button key={y} className={year === y ? 'btn-primary !py-1.5' : 'btn-secondary !py-1.5'} onClick={() => setYear(y)}>{y}</button>
        ))}
      </div>

      {sales.loading && !sales.data && <div className="flex justify-center p-10"><Spinner /></div>}
      <ApiErrorView error={sales.error} onRetry={sales.reload} />
      {sales.data && (
        <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
          <Card>
            <CardHeader title="Summary" />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <StatBox label="Bookings" value={sales.data.summary.count} />
              <StatBox label="Sale value" value={`₹ ${sales.data.summary.value.toLocaleString('en-IN')}`} />
              <StatBox label="Cancelled" value={sales.data.summary.cancelled} />
              <StatBox label="Cancellation rate" value={`${sales.data.summary.cancellationRate}%`} />
            </div>
          </Card>
          <Card>
            <CardHeader title="By status" subtitle="Booking stage distribution" />
            <Table head={['Status', 'Count', 'Value']}>
              {sales.data.byStatus.map((s) => (
                <tr key={s.status}>
                  <td className="td capitalize">{s.status.toLowerCase().replace(/_/g, ' ')}</td>
                  <td className="td tabular-nums">{s.count}</td>
                  <td className="td tabular-nums">{Number(s.value).toLocaleString('en-IN')}</td>
                </tr>
              ))}
            </Table>
            {sales.data.byStatus.length === 0 && <EmptyState title="No data" />}
          </Card>
          <Card>
            <CardHeader title="By salesperson" />
            <Table head={['User', 'Bookings', 'Value']}>
              {sales.data.byUser.map((u) => (
                <tr key={u.name ?? 'none'}>
                  <td className="td text-ink">{u.name ?? 'Unassigned'}</td>
                  <td className="td tabular-nums">{u.count}</td>
                  <td className="td tabular-nums">{Number(u.value).toLocaleString('en-IN')}</td>
                </tr>
              ))}
            </Table>
            {sales.data.byUser.length === 0 && <EmptyState title="No data" />}
          </Card>
          <Card>
            <CardHeader title="By lead source" />
            <Table head={['Source', 'Leads']}>
              {sales.data.bySource.map((s) => (
                <tr key={s.source}>
                  <td className="td text-ink">{s.source}</td>
                  <td className="td tabular-nums">{s.count}</td>
                </tr>
              ))}
            </Table>
            {sales.data.bySource.length === 0 && <EmptyState title="No data" />}
          </Card>
        </div>
      )}

      {cancels.data && (
        <div className="mt-6">
          <Card>
            <CardHeader title="Cancellation analysis" subtitle={`${cancels.data.total} cancellations · ₹ ${cancels.data.totalRefund.toLocaleString('en-IN')} refunded`} />
            <Table head={['Reason category', 'Approval', 'Count', 'Refund amount']}>
              {cancels.data.byCategory.map((c, i) => (
                <tr key={i}>
                  <td className="td text-ink">{c.reasonCategory ?? 'Other'}</td>
                  <td className="td capitalize">{c.status.toLowerCase()}</td>
                  <td className="td tabular-nums">{c.count}</td>
                  <td className="td tabular-nums">₹ {Number(c.amount).toLocaleString('en-IN')}</td>
                </tr>
              ))}
            </Table>
            {cancels.data.byCategory.length === 0 && <EmptyState title="No cancellations" />}
          </Card>
        </div>
      )}
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-surface p-4 shadow-clay-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-faint">{label}</p>
      <p className="mt-1 text-xl font-bold tabular-nums text-ink">{value}</p>
    </div>
  );
}