'use client';

import { useState } from 'react';
import { useApi, fetcher } from '@/lib/fetcher';
import { Badge, Button, Card, CardHeader, Field, Input, Select, Spinner } from '@/components/ui';
import { formatDate, inr } from '@/lib/utils';
import { APPLICANT_RELATIONS, LOAN_STATUS, LOAN_TYPES } from '@/lib/constants';

type Loan = {
  id: string;
  status: string;
  applicantName: string | null;
  applicantRelation: string | null;
  bankName: string | null;
  applicationNo: string | null;
  loanType: string;
  loanAmount: string;
  marginAmount: string | null;
  interestRate: string | null;
  tenureMonths: number | null;
  applicationDate: string;
  sanctionDate: string | null;
  disbursementDate: string | null;
  daysInStage: number;
  stuck: boolean;
  financingShare: number | null;
};

type Payload = { rows: Loan[] };

const label = (s: string) => s.replace(/_/g, ' ').toLowerCase();

/** Loans raised against one booking, plus a form to raise the first one. */
export default function LoanCard({ bookingId, saleValue }: { bookingId: string; saleValue: string | null }) {
  const { data, error, loading, reload } = useApi<Payload>(
    `/api/loans?bookingId=${encodeURIComponent(bookingId)}`,
    { deps: [bookingId] },
  );
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [form, setForm] = useState({
    applicantName: '',
    applicantRelation: 'SELF',
    bankName: '',
    applicationNo: '',
    loanType: LOAN_TYPES[0] as string,
    loanAmount: '',
  });

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const create = async () => {
    if (!form.loanAmount.trim() || Number(form.loanAmount) <= 0) {
      setFormError('Enter the loan amount.');
      return;
    }
    setBusy('create');
    setFormError(null);
    try {
      await fetcher('/api/loans', {
        method: 'POST',
        body: JSON.stringify({
          bookingId,
          applicantName: form.applicantName.trim() || null,
          applicantRelation: form.applicantRelation,
          bankName: form.bankName.trim() || null,
          applicationNo: form.applicationNo.trim() || null,
          loanType: form.loanType,
          loanAmount: form.loanAmount.trim(),
        }),
      });
      setOpen(false);
      setForm({ applicantName: '', applicantRelation: 'SELF', bankName: '', applicationNo: '', loanType: LOAN_TYPES[0] as string, loanAmount: '' });
      reload();
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const advance = async (loan: Loan) => {
    const next = LOAN_STATUS[LOAN_STATUS.indexOf(loan.status as never) + 1];
    if (!next) return;
    setBusy(loan.id);
    setFormError(null);
    try {
      await fetcher(`/api/loans/${loan.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: next }),
      });
      reload();
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (loading && !data) {
    return (
      <Card>
        <CardHeader title="Financing" />
        <div className="flex justify-center py-6"><Spinner /></div>
      </Card>
    );
  }
  if (error) {
    return (
      <Card>
        <CardHeader title="Financing" />
        <p className="text-sm text-ink-faint">{error.message}</p>
      </Card>
    );
  }

  const rows = data?.rows ?? [];
  const ceiling = Number(saleValue ?? 0);

  return (
    <Card>
      <CardHeader
        title="Financing"
        subtitle={rows.length ? 'Loans raised against this booking' : 'No loan raised yet'}
        action={
          <Button variant="secondary" onClick={() => setOpen((v) => !v)}>
            {rows.length ? 'Raise another' : 'Raise loan'}
          </Button>
        }
      />

      {rows.length === 0 && !open && (
        <p className="text-sm text-ink-faint">
          Raise a loan to track the application through sanction and disbursement.
        </p>
      )}

      <div className="space-y-2">
        {rows.map((l) => {
          const next = LOAN_STATUS[LOAN_STATUS.indexOf(l.status as never) + 1];
          return (
            <div
              key={l.id}
              className={`rounded-2xl bg-clay-deep p-3 shadow-clay-inset-sm ${l.stuck ? 'ring-1 ring-rose-300' : ''}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink">
                    {l.applicantName ?? 'Applicant not named'}
                    {l.applicantRelation ? (
                      <span className="ml-1 text-xs font-normal text-ink-faint">
                        ({label(l.applicantRelation)})
                      </span>
                    ) : null}
                  </p>
                  <p className="text-xs text-ink-faint">
                    {l.bankName ?? 'No bank assigned'} · {label(l.loanType)}
                    {l.applicationNo ? ` · ${l.applicationNo}` : ''}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-bold tabular-nums text-ink">{inr(l.loanAmount)}</p>
                  <p className="text-[11px] text-ink-faint">
                    {l.financingShare !== null ? `${l.financingShare}% of sale` : ''}
                  </p>
                </div>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Badge tone={l.status === 'DISBURSED' ? 'green' : 'gray'}>{label(l.status)}</Badge>
                <span className={`text-[11px] ${l.stuck ? 'font-bold text-rose-600' : 'text-ink-faint'}`}>
                  {l.daysInStage}d in stage
                </span>
                {l.sanctionDate && <span className="text-[11px] text-ink-faint">Sanctioned {formatDate(l.sanctionDate)}</span>}
                {l.disbursementDate && <span className="text-[11px] text-ink-faint">Disbursed {formatDate(l.disbursementDate)}</span>}
                {next && next !== 'REJECTED' && (
                  <Button
                    variant="secondary"
                    className="ml-auto"
                    loading={busy === l.id}
                    onClick={() => advance(l)}
                  >
                    Move to {label(next)}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {formError && (
        <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">
          {formError}
        </p>
      )}

      {open && (
        <div className="mt-3 space-y-3 rounded-2xl bg-clay-deep p-4 shadow-clay-inset-sm">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Applicant name" hint="Leave blank for the customer themselves">
              <Input value={form.applicantName} onChange={set('applicantName')} placeholder="e.g. Co-applicant" />
            </Field>
            <Field label="Relation">
              <Select value={form.applicantRelation} onChange={set('applicantRelation')}>
                {APPLICANT_RELATIONS.map((r) => (
                  <option key={r} value={r}>{label(r)}</option>
                ))}
              </Select>
            </Field>
            <Field label="Bank">
              <Input value={form.bankName} onChange={set('bankName')} placeholder="e.g. HDFC Home Loan" />
            </Field>
            <Field label="Application no.">
              <Input value={form.applicationNo} onChange={set('applicationNo')} placeholder="Optional" />
            </Field>
            <Field label="Loan type">
              <Select value={form.loanType} onChange={set('loanType')}>
                {LOAN_TYPES.map((t) => (
                  <option key={t} value={t}>{label(t)}</option>
                ))}
              </Select>
            </Field>
            <Field
              label="Loan amount"
              hint={ceiling > 0 ? `Cannot exceed ${inr(ceiling)}` : undefined}
            >
              <Input type="number" inputMode="decimal" value={form.loanAmount} onChange={set('loanAmount')} className="text-right" />
            </Field>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={create} loading={busy === 'create'} className="ml-auto">Raise loan</Button>
          </div>
        </div>
      )}
    </Card>
  );
}
