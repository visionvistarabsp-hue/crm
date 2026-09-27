'use client';

import { useState } from 'react';
import { useApi, fetcher } from '@/lib/fetcher';
import {
  Button, Card, CardHeader, EmptyState, PageHeader, Select, Spinner, Stat, Table,
} from '@/components/ui';
import { formatDate, inr } from '@/lib/utils';
import { LOAN_STATUS, LOAN_TYPES } from '@/lib/constants';

type Loan = {
  id: string;
  bookingId: string;
  bookingNo: string;
  customerName: string;
  customerPhone: string | null;
  projectName: string;
  unitLabel: string | null;
  saleValue: string;
  applicantName: string | null;
  bankName: string | null;
  applicationNo: string | null;
  loanType: string;
  loanAmount: string;
  marginAmount: string | null;
  status: string;
  applicationDate: string;
  sanctionDate: string | null;
  disbursementDate: string | null;
  daysInStage: number;
  stuck: boolean;
  financingShare: number | null;
};

type Summary = {
  total: number;
  open: number;
  stuck: number;
  disbursed: number;
  totalDisbursed: number;
  pendingDisbursement: number;
  byStatus: Array<{ status: string; count: number; amount: number }>;
  banks: Array<{ bank: string; count: number; amount: number }>;
};

type NeedsLoan = { id: string; bookingNo: string; saleValue: number; customerName: string; bookingDate: string };

type Payload = { rows: Loan[]; summary: Summary; needsLoan: NeedsLoan[] };

const STATUS_TONE: Record<string, string> = {
  APPLIED: 'bg-clay-dark text-ink-muted',
  DOCUMENTS_PENDING: 'bg-amber-100 text-amber-800',
  IN_PROGRESS: 'bg-sky-100 text-sky-800',
  SANCTIONED: 'bg-violet-100 text-violet-800',
  DISBURSED: 'bg-emerald-100 text-emerald-800',
  REJECTED: 'bg-rose-100 text-rose-800',
  CLOSED: 'bg-clay-dark text-ink-muted',
};

const label = (s: string) => s.replace(/_/g, ' ').toLowerCase();

function StatusPill({ status }: { status: string }) {
  return (
    <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold capitalize ${STATUS_TONE[status] ?? 'bg-clay-dark text-ink-muted'}`}>
      {label(status)}
    </span>
  );
}

export default function LoansPage() {
  const [status, setStatus] = useState('');
  const [stuck, setStuck] = useState(false);
  const { data, error, loading, reload } = useApi<Payload>(
    `/api/loans?${new URLSearchParams({
      ...(status ? { status } : {}),
      ...(stuck ? { stuck: 'true' } : {}),
    })}`,
  );

  const [advancing, setAdvancing] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const advance = async (loan: Loan) => {
    const next = LOAN_STATUS[LOAN_STATUS.indexOf(loan.status as never) + 1];
    if (!next) return;
    setAdvancing(loan.id);
    setActionError(null);
    try {
      await fetcher(`/api/loans/${loan.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: next }),
      });
      reload();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setAdvancing(null);
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
  if (!data) return <EmptyState title="No loan data" />;

  const rows = data.rows;
  const s = data.summary;

  return (
    <div>
      <PageHeader
        title="Loans"
        subtitle="Financing pipeline from application to disbursement"
        action={
          <div className="flex items-center gap-2">
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="!w-auto">
              <option value="">All stages</option>
              {LOAN_STATUS.map((v) => (
                <option key={v} value={v}>{label(v)}</option>
              ))}
            </Select>
            <Button
              variant={stuck ? 'primary' : 'secondary'}
              onClick={() => setStuck((v) => !v)}
            >
              Stuck only
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Open loans" value={String(s.open)} hint={`${s.total} in total`} />
        <Stat
          label="Stuck"
          value={String(s.stuck)}
          hint={s.stuck === 0 ? 'Everything is moving' : 'Sitting too long in a stage'}
          tone={s.stuck > 0 ? 'ring-2 ring-rose-500/40' : undefined}
        />
        <Stat label="Disbursed" value={String(s.disbursed)} hint={inr(s.totalDisbursed)} />
        <Stat
          label="Pending disbursement"
          value={String(s.pendingDisbursement)}
          hint="Sanctioned, money not in yet"
        />
      </div>

      {actionError && (
        <div className="mt-4 rounded-2xl bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">
          {actionError}
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader
              title="Loan pipeline"
              subtitle={stuck ? 'Only loans sitting too long' : 'Stuck loans sort first'}
            />
            {rows.length === 0 ? (
              <EmptyState
                title={stuck ? 'Nothing is stuck' : 'No loans yet'}
                subtitle={stuck ? 'Every open loan has moved recently' : 'Raise a loan from a booking to see it here'}
              />
            ) : (
              <Table head={['Applicant', 'Booking', 'Bank', 'Loan', 'Stage', 'In stage', '']}>
                {rows.map((l) => {
                  const idx = LOAN_STATUS.indexOf(l.status as never);
                  const next = LOAN_STATUS[idx + 1];
                  return (
                    <tr key={l.id} className={l.stuck ? 'bg-rose-50/40' : undefined}>
                      <td className="px-5 py-4">
                        <p className="text-sm font-semibold text-ink">
                          {l.applicantName ?? l.customerName}
                        </p>
                        <p className="text-[11px] text-ink-faint">
                          {l.projectName}
                          {l.unitLabel ? ` · ${l.unitLabel}` : ''}
                          {l.financingShare !== null ? ` · ${l.financingShare}% financed` : ''}
                        </p>
                      </td>
                      <td className="px-5 py-4 text-sm font-semibold text-ink-muted">{l.bookingNo}</td>
                      <td className="px-5 py-4 text-sm text-ink-muted">
                        {l.bankName ?? <span className="text-ink-faint">Not assigned</span>}
                      </td>
                      <td className="px-5 py-4">
                        <p className="text-sm font-bold tabular-nums text-ink">{inr(l.loanAmount)}</p>
                        <p className="text-[11px] capitalize text-ink-faint">{label(l.loanType)}</p>
                      </td>
                      <td className="px-5 py-4"><StatusPill status={l.status} /></td>
                      <td className="px-5 py-4">
                        <span className={`text-sm font-bold tabular-nums ${l.stuck ? 'text-rose-600' : 'text-ink-muted'}`}>
                          {l.daysInStage}d
                        </span>
                      </td>
                      <td className="px-5 py-4 text-right">
                        {next && next !== 'REJECTED' ? (
                          <Button variant="secondary" onClick={() => advance(l)} loading={advancing === l.id}>
                            {label(next)}
                          </Button>
                        ) : (
                          <span className="text-xs font-semibold text-ink-faint">Complete</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </Table>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="By stage" subtitle="Loan amount sitting in each stage" />
            <div className="space-y-2">
              {s.byStatus.map((b) => (
                <div key={b.status} className="flex items-center justify-between gap-2 text-sm">
                  <StatusPill status={b.status} />
                  <span className="shrink-0 text-right">
                    <span className="font-bold tabular-nums text-ink">{inr(b.amount)}</span>
                    <span className="ml-2 text-xs tabular-nums text-ink-faint">{b.count}</span>
                  </span>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader title="By bank" subtitle="Where the financing sits" />
            {s.banks.length === 0 ? (
              <EmptyState title="No banks yet" />
            ) : (
              <div className="space-y-2">
                {s.banks.map((b) => (
                  <div key={b.bank} className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate text-ink-muted">{b.bank}</span>
                    <span className="shrink-0 text-right">
                      <span className="font-semibold tabular-nums text-ink">{inr(b.amount)}</span>
                      <span className="ml-2 text-xs tabular-nums text-ink-faint">{b.count}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {!stuck && data.needsLoan.length > 0 && (
            <Card>
              <CardHeader
                title="Bookings needing a loan"
                subtitle="Raised from a booking, not from here"
              />
              <div className="space-y-2">
                {data.needsLoan.slice(0, 8).map((b) => (
                  <div key={b.id} className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-ink">{b.customerName}</p>
                      <p className="text-[11px] text-ink-faint">
                        {b.bookingNo} · {formatDate(b.bookingDate)}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs font-bold tabular-nums text-ink-muted">
                      {inr(b.saleValue)}
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-[11px] text-ink-faint">
                Loan types available: {LOAN_TYPES.map(label).join(', ')}.
              </p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
