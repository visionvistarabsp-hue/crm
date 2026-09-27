'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useApi } from '@/lib/useApi';
import { ApiErrorView } from '@/lib/fetcher';
import { Button, Card, EmptyState, Input, PageHeader, Pagination, Select, Spinner, StatusBadge, Table } from '@/components/ui';
import { BOOKING_STATUS } from '@/lib/constants';

type Booking = {
  id: string; bookingNo: string; customerName?: string | null; projectName?: string | null;
  unitNo?: string | null; saleValue: string | null; bookingAmount: string | null;
  status: string; bookingDate: string; salespersonName?: string | null;
};

export default function BookingsPage() {
  const [params, setParams] = useState({ page: 1, pageSize: 25, status: '', q: '' });
  const url = useMemo(() => {
    const sp = new URLSearchParams({ page: String(params.page), pageSize: String(params.pageSize) });
    if (params.status) sp.set('status', params.status);
    if (params.q) sp.set('q', params.q);
    return `/api/bookings?${sp.toString()}`;
  }, [params]);
  const { data, error, loading, reload } = useApi<{ items: Booking[]; total: number }>(url, { deps: [params] });

  return (
    <div>
      <PageHeader title="Bookings" subtitle="Units booked by your team" action={<Link href="/bookings/new" className="btn-primary">New booking</Link>} />
      <div className="card mb-4 flex flex-col gap-3 p-4 sm:flex-row">
        <Input placeholder="Search customer…" value={params.q} onChange={(e) => setParams((p) => ({ ...p, q: e.target.value, page: 1 }))} />
        <Select aria-label="Filter by status" className="!w-auto" value={params.status} onChange={(e) => setParams((p) => ({ ...p, status: e.target.value, page: 1 }))}>
          <option value="">All statuses</option>
          {BOOKING_STATUS.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
        </Select>
      </div>

      {loading && !data && <div className="flex justify-center p-10"><Spinner /></div>}
      <ApiErrorView error={error} onRetry={reload} />

      <div className="card">
        <Table head={['Booking', 'Customer', 'Project / Unit', 'Value', 'Paid', 'Status', 'Date']}>
          {data?.items?.map((b) => (
            <tr key={b.id} className="cursor-pointer hover:bg-primary-50/40" onClick={() => (window.location.href = `/bookings/${b.id}`)}>
              <td className="td font-medium text-ink">{b.bookingNo}</td>
              <td className="td text-ink">{b.customerName ?? '—'}</td>
              <td className="td text-ink-muted">{[b.projectName, b.unitNo].filter(Boolean).join(' · ')}</td>
              <td className="td tabular-nums">{b.saleValue ? `₹ ${Number(b.saleValue).toLocaleString('en-IN')}` : '—'}</td>
              <td className="td tabular-nums">{b.bookingAmount ? `₹ ${Number(b.bookingAmount).toLocaleString('en-IN')}` : '—'}</td>
              <td className="td"><StatusBadge status={b.status} /></td>
              <td className="td text-ink-faint">{new Date(b.bookingDate).toLocaleDateString('en-IN')}</td>
            </tr>
          ))}
        </Table>
        {data && data.items.length === 0 && <EmptyState title="No bookings match" />}
        {data && <Pagination page={params.page} total={data.total} pageSize={params.pageSize} onChange={(page) => setParams((p) => ({ ...p, page }))} />}
      </div>
    </div>
  );
}