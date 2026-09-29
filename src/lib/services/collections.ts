/**
 * Collection: the agreed instalment plan, what has been paid against it, and
 * what is overdue.
 *
 * A real-estate booking is not one payment. It is booking amount, down
 * payment, construction-linked instalments and finally possession. Recording
 * only "payments received" hides every outstanding instalment, so this module
 * keeps a schedule and reconciles it against the payments table - which stays
 * the single source of truth for money received.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { ApiError, type Actor } from '@/lib/api';
import { writeAudit } from '@/lib/audit';
import { db } from '@/lib/db';
import { bookings, customers, paymentMilestones, payments, projects, users } from '@/lib/db/schema';
import { nextNumber } from './counters';
import { num, round2 } from './forecast';
import type { MilestoneStatus } from '@/lib/constants';

const DAY_MS = 86_400_000;

/** Whole paise-safe comparison; money is numeric(14,2) from Postgres. */
const MONEY_EPSILON = 0.01;

export function isSettled(amount: number, paid: number): boolean {
  return paid + MONEY_EPSILON >= amount;
}

export interface MilestoneView {
  id: string;
  seq: number;
  name: string;
  dueDate: Date;
  percentage: string | null;
  amount: string;
  status: MilestoneStatus;
  paidAmount: string;
  outstanding: number;
  daysUntilDue: number;
  overdue: boolean;
  paidAt: Date | null;
  notes: string | null;
}

export interface ScheduleView {
  bookingId: string;
  bookingNo: string;
  saleValue: string;
  currency: 'INR';
  totalPlanned: number;
  totalReceived: number;
  totalOutstanding: number;
  /** How much has been received with no milestone to allocate it to. */
  unallocated: number;
  nextDue: { name: string; dueDate: Date; amount: number } | null;
  overdueCount: number;
  milestones: MilestoneView[];
}

async function loadBooking(actor: Actor, bookingId: string) {
  const rows = await db.query.bookings.findFirst({
    where: eq(bookings.id, bookingId),
    with: { customer: { columns: { id: true, name: true } } },
  });
  if (!rows) throw new ApiError(404, 'Booking not found', 'NOT_FOUND');
  return rows;
}

/**
 * Build the schedule view for a booking.
 *
 * Derived fields (outstanding, overdue, next due) are computed here rather than
 * stored so they can never drift from the underlying amounts.
 */
export async function getSchedule(actor: Actor, bookingId: string, now = new Date()): Promise<ScheduleView> {
  const booking = await loadBooking(actor, bookingId);

  const [ms, pays] = await Promise.all([
    db
      .select()
      .from(paymentMilestones)
      .where(eq(paymentMilestones.bookingId, bookingId))
      .orderBy(asc(paymentMilestones.seq)),
    db
      .select({ id: payments.id, amount: payments.amount, status: payments.status, paymentDate: payments.paymentDate })
      .from(payments)
      .where(eq(payments.bookingId, bookingId)),
  ]);

  const saleValue = num(booking.saleValue);
  const received = round2(
    pays.filter((p) => p.status === 'RECEIVED').reduce((s, p) => s + num(p.amount), 0),
  );

  const milestones: MilestoneView[] = ms.map((m) => {
    const amount = num(m.amount);
    const paid = num(m.paidAmount);
    const due = new Date(m.dueDate);
    const daysUntilDue = Math.ceil((due.getTime() - now.getTime()) / DAY_MS);
    const settled = m.status === 'PAID' || m.status === 'WAIVED';
    return {
      id: m.id,
      seq: m.seq,
      name: m.name,
      dueDate: due,
      percentage: m.percentage,
      amount: m.amount,
      status: m.status as MilestoneStatus,
      paidAmount: m.paidAmount,
      outstanding: settled ? 0 : round2(Math.max(0, amount - paid)),
      daysUntilDue,
      overdue: !settled && due.getTime() < now.getTime(),
      paidAt: m.paidAt,
      notes: m.notes,
    };
  });

  const totalPlanned = round2(milestones.reduce((s, m) => s + num(m.amount), 0));
  const allocated = round2(milestones.reduce((s, m) => s + num(m.paidAmount), 0));
  const next = milestones
    .filter((m) => m.status !== 'PAID' && m.status !== 'WAIVED')
    .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime())[0];

  return {
    bookingId,
    bookingNo: booking.bookingNo,
    saleValue: booking.saleValue,
    currency: 'INR',
    totalPlanned,
    totalReceived: received,
    totalOutstanding: round2(Math.max(0, totalPlanned - allocated)),
    unallocated: round2(Math.max(0, received - allocated)),
    nextDue: next ? { name: next.name, dueDate: next.dueDate, amount: next.outstanding } : null,
    overdueCount: milestones.filter((m) => m.overdue).length,
    milestones,
  };
}

/**
 * Create or replace the plan for a booking.
 *
 * Replacing is destructive, so it refuses once money has been allocated -
 * otherwise a typo in the plan would silently discard paid history.
 */
export async function setSchedule(
  actor: Actor,
  bookingId: string,
  plan: Array<{ name: string; dueDate: string | Date; percentage?: number | null; amount?: string | number | null; notes?: string | null }>,
): Promise<ScheduleView> {
  const booking = await loadBooking(actor, bookingId);
  if (booking.status === 'CANCELLED') {
    throw new ApiError(422, 'Cannot build a payment plan for a cancelled booking');
  }

  const existing = await db
    .select({ id: paymentMilestones.id, paidAmount: paymentMilestones.paidAmount })
    .from(paymentMilestones)
    .where(eq(paymentMilestones.bookingId, bookingId));

  const alreadyAllocated = existing.some((m) => num(m.paidAmount) > 0);
  if (alreadyAllocated) {
    throw new ApiError(
      409,
      'Payments are already allocated to this plan. Edit the existing milestones instead of replacing the plan.',
      'PLAN_HAS_PAYMENTS',
    );
  }

  const saleValue = num(booking.saleValue);
  const rows = plan.map((p, i) => {
    const amount = p.amount != null ? num(p.amount) : round2((saleValue * num(p.percentage)) / 100);
    return {
      bookingId,
      seq: i + 1,
      name: p.name,
      dueDate: typeof p.dueDate === 'string' ? new Date(p.dueDate) : p.dueDate,
      percentage: p.percentage != null ? String(p.percentage) : null,
      amount: String(amount),
      status: 'PENDING' as const,
      paidAmount: '0',
      createdById: actor.user.id,
    };
  });

  await db.transaction(async (tx) => {
    await tx.delete(paymentMilestones).where(eq(paymentMilestones.bookingId, bookingId));
    await tx.insert(paymentMilestones).values(rows);
  });

  await writeAudit({
    actor,
    action: 'UPDATE',
    entity: 'payment_schedule',
    entityId: bookingId,
    newValue: { milestones: rows.map((r) => ({ name: r.name, amount: r.amount, due: r.dueDate })) },
  });

  return getSchedule(actor, bookingId);
}

/** Status implied by the amounts, ignoring a manually waived milestone. */
export function deriveStatus(paid: number, amount: number, current: string): MilestoneStatus {
  if (current === 'WAIVED') return 'WAIVED';
  if (isSettled(amount, paid)) return 'PAID';
  if (paid > 0) return 'PARTIAL';
  return 'PENDING';
}

export interface PaymentResult {
  paymentId: string;
  receiptNo: string | null;
  /** What the payment was applied to, oldest due first. */
  allocations: Array<{ milestoneId: string; name: string; amount: number }>;
  unallocated: number;
  schedule: ScheduleView;
}

/**
 * Record a payment against a booking and spread it across the plan.
 *
 * Money goes to the oldest outstanding milestone first, because that is the
 * order a customer actually pays in and it keeps the receivables age honest.
 * The `payments` row is written first and is authoritative; milestone columns
 * are a cached projection that `getSchedule` can always recompute.
 */
export async function recordPayment(
  actor: Actor,
  input: {
    bookingId: string;
    amount: string | number;
    method: string;
    reference?: string | null;
    paymentDate?: string | Date;
    /** Restrict the payment to one milestone instead of auto-allocating. */
    milestoneId?: string | null;
  },
): Promise<PaymentResult> {
  const booking = await loadBooking(actor, input.bookingId);
  if (booking.status === 'CANCELLED') {
    throw new ApiError(422, 'Cannot record a payment against a cancelled booking');
  }

  const amount = round2(num(input.amount));
  if (amount <= 0) throw new ApiError(422, 'Amount must be greater than 0', 'VALIDATION');

  const paymentDate = input.paymentDate
    ? typeof input.paymentDate === 'string'
      ? new Date(input.paymentDate)
      : input.paymentDate
    : new Date();

  const [payment] = await db
    .insert(payments)
    .values({
      bookingId: booking.id,
      customerId: booking.customerId,
      amount: String(amount),
      paymentDate,
      method: input.method,
      reference: input.reference ?? null,
      status: 'RECEIVED',
      receivedById: actor.user.id,
    })
    .returning();

  const allocations: Array<{ milestoneId: string; name: string; amount: number }> = [];
  let left = amount;

  if (input.milestoneId) {
    const target = await db
      .select()
      .from(paymentMilestones)
      .where(and(eq(paymentMilestones.id, input.milestoneId), eq(paymentMilestones.bookingId, booking.id)))
      .limit(1);
    if (!target[0]) throw new ApiError(404, 'Milestone not found on this booking', 'NOT_FOUND');
    const applied = round2(Math.min(left, Math.max(0, num(target[0].amount) - num(target[0].paidAmount))));
    if (applied > 0) {
      await applyToMilestone(target[0], applied, now());
      allocations.push({ milestoneId: target[0].id, name: target[0].name, amount: applied });
      left = round2(left - applied);
    }
  } else {
    const open = await db
      .select()
      .from(paymentMilestones)
      .where(
        and(
          eq(paymentMilestones.bookingId, booking.id),
          inArray(paymentMilestones.status, ['PENDING', 'PARTIAL']),
        ),
      )
      .orderBy(asc(paymentMilestones.dueDate), asc(paymentMilestones.seq));

    for (const m of open) {
      if (left <= MONEY_EPSILON) break;
      const applied = round2(Math.min(left, Math.max(0, num(m.amount) - num(m.paidAmount))));
      if (applied <= 0) continue;
      await applyToMilestone(m, applied, paymentDate);
      allocations.push({ milestoneId: m.id, name: m.name, amount: applied });
      left = round2(left - applied);
    }
  }

  await writeAudit({
    actor,
    action: 'CREATE',
    entity: 'payment',
    entityId: payment.id,
    newValue: { amount, method: input.method, allocations },
    meta: { bookingId: booking.id, source: input.milestoneId ? 'milestone' : 'auto' },
  });

  // Issue the receipt here rather than leaving it to a second call: a customer
  // who has just paid should not have to ask for their paperwork. issueReceipt
  // is idempotent, so a retry cannot mint a second number.
  const receipt = await issueReceipt(actor, payment.id);

  return {
    paymentId: payment.id,
    receiptNo: receipt.receiptNo,
    allocations,
    unallocated: left,
    schedule: await getSchedule(actor, booking.id),
  };
}

function now() {
  return new Date();
}

async function applyToMilestone(
  m: typeof paymentMilestones.$inferSelect,
  amount: number,
  at: Date,
): Promise<void> {
  const paid = round2(num(m.paidAmount) + amount);
  const status = deriveStatus(paid, num(m.amount), m.status);
  await db
    .update(paymentMilestones)
    .set({ paidAmount: String(paid), status, paidAt: status === 'PAID' ? at : null, updatedAt: new Date() })
    .where(eq(paymentMilestones.id, m.id));
}

// ---------------------------------------------------------------- Receipts

export interface ReceiptView {
  paymentId: string;
  receiptNo: string;
  receiptDate: Date;
  issuedAt: Date;
  voided: boolean;
  amount: string;
  method: string;
  reference: string | null;
  customerName: string;
  customerPhone: string | null;
  bookingNo: string;
  projectName: string;
  unitLabel: string | null;
  saleValue: string;
  amountInWords: string;
  allocations: Array<{ name: string; amount: number }>;
  issuedBy: string | null;
}

/**
 * Issue a receipt for a payment.
 *
 * Idempotent: re-issuing returns the existing number rather than minting a
 * second one, so a reprint never double-counts. A voided receipt can be
 * reissued deliberately by clearing the void first.
 */
export async function issueReceipt(actor: Actor, paymentId: string): Promise<ReceiptView> {
  const rows = await db
    .select({
      p: payments,
      c: { name: customers.name, phone: customers.phone },
      b: { bookingNo: bookings.bookingNo, saleValue: bookings.saleValue, projectId: bookings.projectId, unitId: bookings.unitId },
    })
    .from(payments)
    .innerJoin(customers, eq(customers.id, payments.customerId!))
    .innerJoin(bookings, eq(bookings.id, payments.bookingId))
    .where(eq(payments.id, paymentId))
    .limit(1);

  const row = rows[0];
  if (!row) throw new ApiError(404, 'Payment not found', 'NOT_FOUND');
  if (row.p.status !== 'RECEIVED') {
    throw new ApiError(422, 'A receipt can only be issued for a received payment');
  }
  if (row.p.receiptVoidedAt) {
    throw new ApiError(409, 'This receipt was voided. Reissue it before printing a new one.', 'RECEIPT_VOIDED');
  }

  let receiptNo = row.p.receiptNo;
  if (!receiptNo) {
    receiptNo = await nextNumber('receipt', 'RCPT');
    await db
      .update(payments)
      .set({ receiptNo, receiptIssuedAt: new Date() })
      .where(eq(payments.id, paymentId));
  }

  await writeAudit({
    actor,
    action: 'CREATE',
    entity: 'receipt',
    entityId: paymentId,
    newValue: { receiptNo },
    meta: { bookingNo: row.b.bookingNo, amount: row.p.amount },
  });

  return getReceipt(actor, paymentId);
}

export async function getReceipt(actor: Actor, paymentId: string): Promise<ReceiptView> {
  const rows = await db
    .select({
      p: payments,
      c: { name: customers.name, phone: customers.phone },
      b: { bookingNo: bookings.bookingNo, saleValue: bookings.saleValue, projectId: bookings.projectId, unitId: bookings.unitId, towerId: bookings.towerId },
      u: { unitNo: sql<string>`${bookings.unitId}` },
      issuer: users.name,
    })
    .from(payments)
    .innerJoin(customers, eq(customers.id, payments.customerId!))
    .innerJoin(bookings, eq(bookings.id, payments.bookingId))
    .leftJoin(users, eq(users.id, payments.receivedById))
    .where(eq(payments.id, paymentId))
    .limit(1);

  const row = rows[0];
  if (!row) throw new ApiError(404, 'Payment not found', 'NOT_FOUND');
  if (!row.p.receiptNo) {
    throw new ApiError(404, 'No receipt has been issued for this payment', 'NOT_FOUND');
  }

  // Look the project up by its own id. Wrapping bookings.projectId inside a
  // projects query asks Postgres for projects.project_id, which does not exist.
  const [project] = row.b.projectId
    ? await db
        .select({ name: projects.name })
        .from(projects)
        .where(eq(projects.id, row.b.projectId))
        .limit(1)
    : [];

  // Show what this receipt settled, so a customer can tie it to their plan.
  const ms = await db
    .select()
    .from(paymentMilestones)
    .where(eq(paymentMilestones.bookingId, row.p.bookingId))
    .orderBy(asc(paymentMilestones.seq));

  const amount = num(row.p.amount);
  const allocations: Array<{ name: string; amount: number }> = [];
  let left = amount;
  for (const m of ms) {
    if (left <= MONEY_EPSILON) break;
    const outstanding = Math.max(0, num(m.amount) - num(m.paidAmount));
    const take = round2(Math.min(left, outstanding));
    if (take > 0) {
      allocations.push({ name: m.name, amount: take });
      left = round2(left - take);
    }
  }

  return {
    paymentId,
    receiptNo: row.p.receiptNo,
    receiptDate: row.p.paymentDate,
    issuedAt: row.p.receiptIssuedAt ?? row.p.createdAt,
    voided: Boolean(row.p.receiptVoidedAt),
    amount: row.p.amount,
    method: row.p.method,
    reference: row.p.reference,
    customerName: row.c.name,
    customerPhone: row.c.phone,
    bookingNo: row.b.bookingNo,
    projectName: project?.name ?? '',
    unitLabel: null,
    saleValue: row.b.saleValue,
    amountInWords: amountInWords(amount),
    allocations,
    issuedBy: row.issuer ?? null,
  };
}

/** Void a receipt without touching the money it represents. */
export async function voidReceipt(actor: Actor, paymentId: string, reason: string): Promise<void> {
  const [row] = await db
    .select({ id: payments.id, receiptNo: payments.receiptNo })
    .from(payments)
    .where(eq(payments.id, paymentId))
    .limit(1);
  if (!row?.receiptNo) throw new ApiError(404, 'No receipt issued for this payment', 'NOT_FOUND');
  if (row.receiptNo === null) throw new ApiError(404, 'No receipt issued for this payment', 'NOT_FOUND');

  await db
    .update(payments)
    .set({ receiptVoidedAt: new Date(), receiptVoidReason: reason, updatedAt: new Date() })
    .where(eq(payments.id, paymentId));

  await writeAudit({
    actor,
    action: 'CANCEL',
    entity: 'receipt',
    entityId: paymentId,
    newValue: { receiptNo: row.receiptNo, reason },
  });
}

// ---------------------------------------------------------------- Ageing

export interface AgingBucket {
  key: string;
  label: string;
  count: number;
  amount: number;
}

export interface OverdueRow {
  milestoneId: string;
  bookingId: string;
  bookingNo: string;
  customerName: string;
  projectName: string;
  salespersonName: string | null;
  name: string;
  dueDate: Date;
  amount: number;
  paidAmount: number;
  outstanding: number;
  daysOverdue: number;
}

export interface CollectionsReport {
  /** Outstanding across every open milestone the actor can see. */
  totalOutstanding: number;
  totalOverdue: number;
  overdueCount: number;
  buckets: AgingBucket[];
  overdue: OverdueRow[];
}

/** Bucket key for a number of days past due. Pure - unit tested. */
export function agingKey(daysOverdue: number): string {
  if (daysOverdue <= 0) return 'current';
  if (daysOverdue <= 30) return 'd1_30';
  if (daysOverdue <= 60) return 'd31_60';
  if (daysOverdue <= 90) return 'd61_90';
  return 'd90plus';
}

const LABELS: Record<string, string> = {
  current: 'Not due',
  d1_30: '1-30 days',
  d31_60: '31-60 days',
  d61_90: '61-90 days',
  d90plus: '90+ days',
};

const BUCKET_ORDER = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90plus'];

/**
 * Age outstanding balances into buckets. Pure - unit tested.
 *
 * Only buckets that actually hold money are returned, ordered from not-due to
 * most overdue, so the report renders exactly the bands a manager has to act on.
 */
export function ageingBuckets(
  open: Array<{ daysOverdue: number; outstanding: number }>,
): AgingBucket[] {
  const acc = new Map<string, AgingBucket>();
  for (const { daysOverdue, outstanding } of open) {
    // Nothing owed is nothing to chase - counting it would show a manager a
    // band holding one instalment and a zero amount.
    if (outstanding <= MONEY_EPSILON) continue;
    const key = agingKey(daysOverdue);
    const b = acc.get(key) ?? { key, label: LABELS[key] ?? key, count: 0, amount: 0 };
    b.count += 1;
    b.amount = round2(b.amount + outstanding);
    acc.set(key, b);
  }
  return [...acc.values()].sort(
    (a, b) => BUCKET_ORDER.indexOf(a.key) - BUCKET_ORDER.indexOf(b.key),
  );
}

/**
 * Receivables ageing across the books.
 *
 * This is the report the accounts team actually lives in: who owes what, and
 * how long it has been sitting. Every row is a real outstanding milestone, not
 * a derived guess.
 */
export async function getCollectionsReport(
  actor: Actor,
  opts: { projectId?: string; salesPersonId?: string; now?: Date } = {},
): Promise<CollectionsReport> {
  const now = opts.now ?? new Date();

  const rows = await db
    .select({
      m: paymentMilestones,
      bookingNo: bookings.bookingNo,
      customerName: customers.name,
      projectId: bookings.projectId,
      salespersonId: bookings.salespersonId,
    })
    .from(paymentMilestones)
    .innerJoin(bookings, eq(bookings.id, paymentMilestones.bookingId))
    .innerJoin(customers, eq(customers.id, bookings.customerId))
    .where(
      and(
        inArray(paymentMilestones.status, ['PENDING', 'PARTIAL']),
        sql`${bookings.status} <> 'CANCELLED'`,
        opts.projectId ? eq(bookings.projectId, opts.projectId) : undefined,
        opts.salesPersonId ? eq(bookings.salespersonId, opts.salesPersonId) : undefined,
      ),
    );

  const projectIds = [...new Set(rows.map((r) => r.projectId))].filter(
    (id): id is string => id !== null,
  );
  const projectNames = new Map<string, string>();
  if (projectIds.length) {
    // Core select builder, not db.query: the relational builder miscompiles a
    // raw `sql` where against the wrong table and asks for projects.project_id.
    const ps = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(inArray(projects.id, projectIds));
    for (const p of ps) projectNames.set(p.id, p.name);
  }
  const ownerIds = [...new Set(rows.map((r) => r.salespersonId).filter(Boolean))] as string[];
  const ownerNames = new Map<string, string>();
  if (ownerIds.length) {
    const us = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, ownerIds));
    for (const u of us) ownerNames.set(u.id, u.name);
  }

  const overdue: OverdueRow[] = [];
  const ageing: Array<{ daysOverdue: number; outstanding: number }> = [];
  let totalOutstanding = 0;
  let totalOverdue = 0;

  for (const r of rows) {
    const amount = num(r.m.amount);
    const paid = num(r.m.paidAmount);
    const outstanding = round2(Math.max(0, amount - paid));
    if (outstanding <= MONEY_EPSILON) continue;

    const due = new Date(r.m.dueDate);
    const daysOverdue = Math.floor((now.getTime() - due.getTime()) / DAY_MS);
    totalOutstanding = round2(totalOutstanding + outstanding);
    ageing.push({ daysOverdue, outstanding });

    if (daysOverdue > 0) {
      totalOverdue = round2(totalOverdue + outstanding);
      overdue.push({
        milestoneId: r.m.id,
        bookingId: r.m.bookingId,
        bookingNo: r.bookingNo,
        customerName: r.customerName,
        projectName: r.projectId ? (projectNames.get(r.projectId) ?? '') : '',
        salespersonName: r.salespersonId ? ownerNames.get(r.salespersonId) ?? null : null,
        name: r.m.name,
        dueDate: due,
        amount,
        paidAmount: paid,
        outstanding,
        daysOverdue,
      });
    }
  }

  overdue.sort((a, b) => b.daysOverdue - a.daysOverdue);

  return {
    totalOutstanding,
    totalOverdue,
    overdueCount: overdue.length,
    buckets: ageingBuckets(ageing),
    overdue,
  };
}

// ---------------------------------------------------------------- Number to words

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigits(n: number): string {
  if (n < 20) return ONES[n];
  const t = TENS[Math.floor(n / 10)];
  const o = ONES[n % 10];
  return o ? `${t} ${o}` : t;
}

/**
 * Indian-format amount in words. Indian receipts legally require it, and
 * "Rupees One Lakh Twenty Thousand Only" is what gets challenged if missing.
 */
export function amountInWords(amount: number): string {
  // A receipt is never negative, and a negative value would fall through the
  // grouping maths as undefined words, so clamp rather than print nonsense.
  if (!Number.isFinite(amount) || amount <= 0) return 'Rupees Zero Only';

  const rupees = Math.floor(amount);
  // Rounding the fraction can reach 100 paise, which has to carry into a rupee
  // or the "and ... Paise" clause prints "one hundred Paise".
  let paise = Math.round((amount - rupees) * 100);
  let r = rupees;
  if (paise === 100) {
    r += 1;
    paise = 0;
  }
  if (r === 0 && paise === 0) return 'Rupees Zero Only';

  const parts: string[] = [];
  let n = r;

  const crore = Math.floor(n / 10_000_000);
  n %= 10_000_000;
  const lakh = Math.floor(n / 100_000);
  n %= 100_000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  const hundred = Math.floor(n / 100);
  const rest = n % 100;

  if (crore) parts.push(`${twoDigits(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (hundred) parts.push(`${ONES[hundred]} Hundred`);
  if (rest) parts.push(twoDigits(rest));

  let out = `Rupees ${parts.join(' ')}`.replace(/\s+/g, ' ');
  if (paise > 0) out += ` and ${twoDigits(paise)} Paise`;
  return `${out} Only`;
}
