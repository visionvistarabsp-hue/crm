/**
 * Home-loan tracking.
 *
 * In Indian residential sales the buyer usually pays through a mortgage, so
 * the sale is not done when the booking form is signed - it is done when the
 * lender releases the money. Nothing between those two points used to be
 * visible, which meant an "active" deal could sit blocked on a bank for weeks
 * with nobody able to say so.
 *
 * Loan documents are deliberately not duplicated here: `documents` already
 * supports LOAN_DOCUMENT / BANK_DOCUMENT keyed to a booking.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { ApiError, type Actor } from '@/lib/api';
import { writeAudit } from '@/lib/audit';
import { db } from '@/lib/db';
import { bookings, customers, loans, projects, users } from '@/lib/db/schema';
import { CLOSED_LOAN_STATUSES, LOAN_STATUS, OPEN_LOAN_STATUSES, type LoanStatus } from '@/lib/constants';
import { num, round2 } from './forecast';

const DAY_MS = 86_400_000;

/**
 * Days a loan has been sitting in its current stage.
 *
 * A sanctioned loan that has not disbursed in 45 days is not "in progress",
 * it is stuck - and that is the single most useful thing on this screen.
 */
export function daysInStage(loan: { status: string; applicationDate: Date; sanctionDate: Date | null; disbursementDate: Date | null }, now: Date): number {
  const start =
    loan.status === 'DISBURSED' || loan.status === 'CLOSED'
      ? loan.disbursementDate ?? loan.sanctionDate
      : loan.status === 'SANCTIONED'
        ? loan.sanctionDate
        : loan.applicationDate;
  if (!start) return 0;
  return Math.max(0, Math.floor((now.getTime() - new Date(start).getTime()) / DAY_MS));
}

/** A loan counts as stuck once it has been in one stage beyond this. */
export const STUCK_AFTER_DAYS = 30;

/**
 * States with nothing outstanding. DISBURSED belongs here as well as the closed
 * ones: once the bank has paid out, the loan is finished, not stuck - otherwise
 * every completed deal is flagged as stuck forever and the counter only grows.
 */
const SETTLED_LOAN_STATUSES: LoanStatus[] = [...CLOSED_LOAN_STATUSES, 'DISBURSED'];

export function isStuck(loan: Parameters<typeof daysInStage>[0], now: Date): boolean {
  return !SETTLED_LOAN_STATUSES.includes(loan.status as LoanStatus) && daysInStage(loan, now) > STUCK_AFTER_DAYS;
}

/** Days a lender typically takes, used only to flag the outliers. */
export const SANCTION_SLA_DAYS = 21;
export const DISBURSEMENT_SLA_DAYS = 45;

export interface LoanView {
  id: string;
  bookingId: string;
  bookingNo: string;
  customerName: string;
  customerPhone: string | null;
  projectName: string;
  unitLabel: string | null;
  saleValue: string;
  applicantName: string | null;
  applicantRelation: string | null;
  bankName: string | null;
  applicationNo: string | null;
  loanType: string;
  loanAmount: string;
  marginAmount: string | null;
  propertyValuation: string | null;
  interestRate: string | null;
  tenureMonths: number | null;
  emi: string | null;
  status: LoanStatus;
  applicationDate: Date;
  sanctionDate: Date | null;
  disbursementDate: Date | null;
  remarks: string | null;
  daysInStage: number;
  stuck: boolean;
  /** Share of the sale value being financed, as a percentage. */
  financingShare: number | null;
  createdAt: Date;
}

const LOAN_WITH = {
  booking: { columns: { id: true, bookingNo: true, saleValue: true, unitId: true } },
  customer: { columns: { id: true, name: true, phone: true } },
} as const;

function toView(row: typeof loans.$inferSelect & {
  booking: { id: string; bookingNo: string; saleValue: string; unitId: string | null } | null;
  customer: { id: string; name: string; phone: string | null } | null;
}, projectName: string, now: Date): LoanView {
  const saleValue = num(row.booking?.saleValue);
  const loanAmount = num(row.loanAmount);
  const stage = daysInStage(row, now);
  return {
    id: row.id,
    bookingId: row.bookingId,
    bookingNo: row.booking?.bookingNo ?? '',
    customerName: row.customer?.name ?? '',
    customerPhone: row.customer?.phone ?? null,
    projectName,
    unitLabel: null,
    saleValue: row.booking?.saleValue ?? '0',
    applicantName: row.applicantName,
    applicantRelation: row.applicantRelation,
    bankName: row.bankName,
    applicationNo: row.applicationNo,
    loanType: row.loanType,
    loanAmount: row.loanAmount,
    marginAmount: row.marginAmount,
    propertyValuation: row.propertyValuation,
    interestRate: row.interestRate,
    tenureMonths: row.tenureMonths,
    emi: row.emi,
    status: row.status as LoanStatus,
    applicationDate: row.applicationDate,
    sanctionDate: row.sanctionDate,
    disbursementDate: row.disbursementDate,
    remarks: row.remarks,
    daysInStage: stage,
    stuck: isStuck(row, now),
    financingShare: saleValue > 0 ? round2((loanAmount / saleValue) * 100) : null,
    createdAt: row.createdAt,
  };
}

export async function createLoan(
  actor: Actor,
  input: {
    bookingId: string;
    applicantName?: string | null;
    applicantRelation?: string | null;
    bankName?: string | null;
    applicationNo?: string | null;
    loanType: string;
    loanAmount?: string | number | null;
    marginAmount?: string | number | null;
    propertyValuation?: string | number | null;
    interestRate?: number | null;
    tenureMonths?: number | null;
    emi?: string | number | null;
    status: string;
    applicationDate?: string | Date;
    sanctionDate?: string | Date | null;
    disbursementDate?: string | Date | null;
    remarks?: string | null;
  },
) {
  const booking = await db.query.bookings.findFirst({
    where: eq(bookings.id, input.bookingId),
    columns: { id: true, customerId: true, saleValue: true, status: true },
  });
  if (!booking) throw new ApiError(404, 'Booking not found', 'NOT_FOUND');
  if (booking.status === 'CANCELLED') {
    throw new ApiError(422, 'Cannot raise a loan against a cancelled booking');
  }

  const loanAmount = input.loanAmount != null ? num(input.loanAmount) : 0;
  const saleValue = num(booking.saleValue);
  // A loan larger than the property is a data-entry error that would otherwise
  // surface only when the bank rejects the file.
  if (loanAmount > saleValue && saleValue > 0) {
    throw new ApiError(
      422,
      `Loan amount cannot exceed the sale value of Rs ${saleValue.toLocaleString('en-IN')}`,
      'VALIDATION',
    );
  }

  const [row] = await db
    .insert(loans)
    .values({
      bookingId: booking.id,
      customerId: booking.customerId,
      applicantName: input.applicantName ?? null,
      applicantRelation: input.applicantRelation ?? null,
      bankName: input.bankName ?? null,
      applicationNo: input.applicationNo ?? null,
      loanType: input.loanType,
      loanAmount: String(loanAmount),
      marginAmount: input.marginAmount != null ? String(input.marginAmount) : null,
      propertyValuation: input.propertyValuation != null ? String(input.propertyValuation) : null,
      interestRate: input.interestRate != null ? String(input.interestRate) : null,
      tenureMonths: input.tenureMonths ?? null,
      emi: input.emi != null ? String(input.emi) : null,
      status: input.status,
      applicationDate: input.applicationDate
        ? typeof input.applicationDate === 'string'
          ? new Date(input.applicationDate)
          : input.applicationDate
        : new Date(),
      sanctionDate: toDate(input.sanctionDate),
      disbursementDate: toDate(input.disbursementDate),
      remarks: input.remarks ?? null,
      createdById: actor.user.id,
    })
    .returning();

  await writeAudit({
    actor,
    action: 'CREATE',
    entity: 'loan',
    entityId: row.id,
    newValue: { status: row.status, loanAmount: row.loanAmount, bankName: row.bankName },
    meta: { bookingId: booking.id },
  });
  return getLoan(actor, row.id);
}

function toDate(v: string | Date | null | undefined): Date | null {
  if (!v) return null;
  return typeof v === 'string' ? new Date(v) : v;
}

export async function updateLoan(
  actor: Actor,
  loanId: string,
  patch: Record<string, unknown>,
) {
  const existing = await db.query.loans.findFirst({ where: eq(loans.id, loanId) });
  if (!existing) throw new ApiError(404, 'Loan not found', 'NOT_FOUND');

  const nextStatus = typeof patch.status === 'string' ? (patch.status as LoanStatus) : (existing.status as LoanStatus);

  // Guard the two transitions that actually mean something financially: you
  // cannot have a disbursement date without a sanction, and a rejected loan
  // must not keep a disbursement date.
  if ((nextStatus === 'DISBURSED' || patch.disbursementDate) && nextStatus !== 'REJECTED') {
    const sanction = patch.sanctionDate !== undefined ? toDate(patch.sanctionDate as string) : existing.sanctionDate;
    if (!sanction) {
      throw new ApiError(422, 'Record the sanction date before marking the loan disbursed', 'VALIDATION');
    }
  }

  const numeric = ['loanAmount', 'marginAmount', 'propertyValuation', 'emi'] as const;
  const values: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (k === 'sanctionDate' || k === 'disbursementDate' || k === 'applicationDate') {
      values[k] = toDate(v as string);
    } else if (numeric.includes(k as (typeof numeric)[number])) {
      values[k] = v === null ? null : String(num(v as string | number));
    } else if (k === 'tenureMonths' || k === 'interestRate') {
      values[k] = v === null ? null : Number(v);
    } else {
      values[k] = v;
    }
  }
  // Reaching a finished state stamps the close, so ageing stops counting.
  if (SETTLED_LOAN_STATUSES.includes(nextStatus) && !existing.closedAt) {
    values.closedAt = new Date();
  }
  if (!SETTLED_LOAN_STATUSES.includes(nextStatus) && existing.closedAt) {
    values.closedAt = null;
  }

  await db.update(loans).set(values).where(eq(loans.id, loanId));
  await writeAudit({
    actor,
    action: 'UPDATE',
    entity: 'loan',
    entityId: loanId,
    oldValue: { status: existing.status },
    newValue: { status: nextStatus, patch },
  });
  return getLoan(actor, loanId);
}

export async function getLoan(actor: Actor, loanId: string, now = new Date()): Promise<LoanView> {
  const rows = await db.query.loans.findMany({
    where: eq(loans.id, loanId),
    with: LOAN_WITH,
    limit: 1,
  });
  const row = rows[0];
  if (!row) throw new ApiError(404, 'Loan not found', 'NOT_FOUND');
  const projectName = await projectNameFor(row.bookingId);
  return toView(row as never, projectName, now);
}

async function projectNameFor(bookingId: string): Promise<string> {
  const r = await db
    .select({ name: projects.name })
    .from(bookings)
    .innerJoin(projects, eq(projects.id, bookings.projectId))
    .where(eq(bookings.id, bookingId))
    .limit(1);
  return r[0]?.name ?? '';
}

export interface LoanListFilters {
  status?: string;
  bankName?: string;
  projectId?: string;
  /** All loans raised against one booking - used by the booking detail page. */
  bookingId?: string;
  stuckOnly?: boolean;
  limit?: number;
}

export async function listLoans(
  actor: Actor,
  filters: LoanListFilters = {},
  now = new Date(),
): Promise<{ rows: LoanView[]; summary: LoanSummary }> {
  const conditions = [
    filters.status ? eq(loans.status, filters.status) : undefined,
    filters.bankName ? eq(loans.bankName, filters.bankName) : undefined,
  ];

  let rows = await db.query.loans.findMany({
    where: and(...conditions),
    with: LOAN_WITH,
    orderBy: [asc(loans.status), desc(loans.applicationDate)],
    limit: 500,
  });

  if (filters.projectId) {
    const ids = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(eq(bookings.projectId, filters.projectId));
    const set = new Set(ids.map((i) => i.id));
    rows = rows.filter((r) => set.has(r.bookingId));
  }

  if (filters.bookingId) {
    rows = rows.filter((r) => r.bookingId === filters.bookingId);
  }

  // One lookup for every project name instead of one per row.
  const projectIds = [...new Set(rows.map((r) => r.bookingId))];
  const names = new Map<string, string>();
  if (projectIds.length) {
    const ps = await db
      .select({ id: bookings.id, name: projects.name })
      .from(bookings)
      .innerJoin(projects, eq(projects.id, bookings.projectId))
      .where(inArray(bookings.id, projectIds));
    for (const p of ps) names.set(p.id, p.name);
  }

  let views = rows.map((r) => toView(r as never, names.get(r.bookingId) ?? '', now));
  if (filters.stuckOnly) views = views.filter((v) => v.stuck);

  views.sort((a, b) => {
    // Stuck loans lead, then the longest-waiting, then the biggest deal.
    if (a.stuck !== b.stuck) return a.stuck ? -1 : 1;
    if (a.daysInStage !== b.daysInStage) return b.daysInStage - a.daysInStage;
    return num(b.loanAmount) - num(a.loanAmount);
  });

  const limit = Math.min(500, Math.max(1, filters.limit ?? 100));
  return { rows: views.slice(0, limit), summary: summarise(views) };
}

export interface LoanSummary {
  total: number;
  open: number;
  stuck: number;
  disbursed: number;
  totalDisbursed: number;
  pendingDisbursement: number;
  byStatus: Array<{ status: string; count: number; amount: number }>;
  banks: Array<{ bank: string; count: number; amount: number }>;
}

export function summarise(views: LoanView[]): LoanSummary {
  const byStatus = new Map<string, { count: number; amount: number }>();
  const byBank = new Map<string, { count: number; amount: number }>();
  let totalDisbursed = 0;
  let pendingDisbursement = 0;

  for (const v of views) {
    const amount = num(v.loanAmount);
    const s = byStatus.get(v.status) ?? { count: 0, amount: 0 };
    s.count += 1;
    s.amount = round2(s.amount + amount);
    byStatus.set(v.status, s);

    if (v.bankName) {
      const b = byBank.get(v.bankName) ?? { count: 0, amount: 0 };
      b.count += 1;
      b.amount = round2(b.amount + amount);
      byBank.set(v.bankName, b);
    }

    if (v.status === 'DISBURSED' || v.status === 'CLOSED') totalDisbursed = round2(totalDisbursed + amount);
    else if (OPEN_LOAN_STATUSES.includes(v.status)) pendingDisbursement = round2(pendingDisbursement + amount);
  }

  return {
    total: views.length,
    open: views.filter((v) => OPEN_LOAN_STATUSES.includes(v.status)).length,
    stuck: views.filter((v) => v.stuck).length,
    disbursed: views.filter((v) => v.status === 'DISBURSED' || v.status === 'CLOSED').length,
    totalDisbursed,
    pendingDisbursement,
    byStatus: [...byStatus.entries()]
      .map(([status, v]) => ({ status, ...v }))
      .sort(
        (a, b) =>
          LOAN_STATUS.indexOf(a.status as LoanStatus) - LOAN_STATUS.indexOf(b.status as LoanStatus),
      ),
    banks: [...byBank.entries()]
      .map(([bank, v]) => ({ bank, ...v }))
      .sort((a, b) => b.amount - a.amount),
  };
}

/** Active bookings that have no loan raised yet - the list sales works from. */
export async function bookingsNeedingLoan(limit = 50) {
  return db
    .select({
      id: bookings.id,
      bookingNo: bookings.bookingNo,
      saleValue: bookings.saleValue,
      bookingDate: bookings.bookingDate,
      customerName: customers.name,
    })
    .from(bookings)
    .innerJoin(customers, eq(customers.id, bookings.customerId))
    .where(
      and(
        sql`${bookings.status} <> 'CANCELLED'`,
        // NOT EXISTS rather than an anti-join, so the row set stays correct
        // when a booking has several loans.
        sql`not exists (select 1 from ${loans} l where l.booking_id = ${bookings.id})`,
      ),
    )
    .orderBy(desc(bookings.bookingDate))
    .limit(limit);
}
