import { and, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { ApiError, type Actor } from '@/lib/api';
import { writeAudit } from '@/lib/audit';
import { db } from '@/lib/db';
import { bookings, customers, followups, leads, paymentDue, users } from '@/lib/db/schema';
import { recordPayment } from './collections';
import { nextNumber } from './counters';
import { num, round2 } from './forecast';

const MONEY_EPSILON = 0.01;
const DAY_MS = 86_400_000;

function isScoped(actor: Actor): boolean {
  return actor.user.role === 'SALES_EXECUTIVE';
}

function myLeads(actor: Actor) {
  return db.select({ id: leads.id }).from(leads).where(eq(leads.ownerId, actor.user.id));
}

function myCustomers(actor: Actor) {
  return db.select({ id: customers.id }).from(customers).where(eq(customers.ownerId, actor.user.id));
}

export function dueVisibility(actor: Actor) {
  if (!isScoped(actor)) return undefined;
  return or(
    eq(paymentDue.createdById, actor.user.id),
    inArray(paymentDue.customerId, myCustomers(actor)),
    inArray(paymentDue.leadId, myLeads(actor)),
  );
}

export function followupVisibility(actor: Actor) {
  if (!isScoped(actor)) return undefined;
  return or(eq(followups.assignedTo, actor.user.id), isNull(followups.assignedTo));
}

export function leadVisibility(actor: Actor) {
  if (!isScoped(actor)) return undefined;
  return or(eq(leads.ownerId, actor.user.id), isNull(leads.ownerId));
}

export interface EasySummary {
  name: string;
  today: { followups: number; payments: number; total: number };
  newLeads: number;
  activeLeads: number;
  money: { outstanding: number; collectedThisMonth: number };
}

export async function getEasySummary(actor: Actor): Promise<EasySummary> {
  const now = new Date();
  const dayEnd = new Date(now);
  dayEnd.setHours(23, 59, 59, 999);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  // PARTIAL is outstanding too - a due that has some money on it is still
  // collectable, and `listEasyDues` reports it in the same tile this count
  // badges, so counting only PENDING would understate the number.
  const dueCond = [
    dueVisibility(actor),
    inArray(paymentDue.status, ['PENDING', 'PARTIAL']),
    lte(paymentDue.dueDate, dayEnd),
  ];
  const fuCond = [followupVisibility(actor), eq(followups.status, 'PENDING'), lte(followups.scheduledAt, dayEnd)];

  const [[fuRow], [dueRow], [newRow], [activeRow], [outRow], [inRow]] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(followups)
      .where(and(...fuCond)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(paymentDue)
      .where(and(...dueCond)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(leads)
      .where(and(leadVisibility(actor), eq(leads.status, 'NEW'))),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(leads)
      .where(and(leadVisibility(actor), inArray(leads.status, ['NEW', 'FOLLOW_UP', 'VISIT', 'NEGOTIATION']))),
    db
      .select({ total: sql<string>`coalesce(sum(${paymentDue.amount} - coalesce(${paymentDue.paidAmount}, 0)), 0)` })
      .from(paymentDue)
      .where(and(...dueCond)),
    db
      .select({ total: sql<string>`coalesce(sum(${paymentDue.paidAmount}), 0)` })
      .from(paymentDue)
      .where(and(dueVisibility(actor), gte(paymentDue.paidAt, monthStart))),
  ]);

  return {
    name: actor.user.name,
    today: { followups: fuRow?.n ?? 0, payments: dueRow?.n ?? 0, total: (fuRow?.n ?? 0) + (dueRow?.n ?? 0) },
    newLeads: newRow?.n ?? 0,
    activeLeads: activeRow?.n ?? 0,
    money: { outstanding: num(outRow?.total), collectedThisMonth: num(inRow?.total) },
  };
}

export interface EasyFollowupRow {
  id: string;
  type: string;
  scheduledAt: string;
  status: string;
  notes: string | null;
  leadId: string | null;
  leadName: string | null;
  leadPhone: string | null;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  isOverdue: boolean;
}

export async function listEasyFollowups(actor: Actor): Promise<EasyFollowupRow[]> {
  const now = new Date();
  const dayEnd = new Date(now);
  dayEnd.setHours(23, 59, 59, 999);

  const rows = await db
    .select({
      id: followups.id,
      type: followups.type,
      scheduledAt: followups.scheduledAt,
      status: followups.status,
      notes: followups.notes,
      leadId: followups.leadId,
      leadName: leads.name,
      leadPhone: leads.phone,
      customerId: followups.customerId,
      customerName: customers.name,
      customerPhone: customers.phone,
    })
    .from(followups)
    .leftJoin(leads, eq(followups.leadId, leads.id))
    .leftJoin(customers, eq(followups.customerId, customers.id))
    .where(and(followupVisibility(actor), eq(followups.status, 'PENDING'), lte(followups.scheduledAt, dayEnd)))
    .orderBy(followups.scheduledAt);

  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    scheduledAt: r.scheduledAt.toISOString(),
    status: r.status,
    notes: r.notes,
    leadId: r.leadId,
    leadName: r.leadName,
    leadPhone: r.leadPhone,
    customerId: r.customerId,
    customerName: r.customerName,
    customerPhone: r.customerPhone,
    isOverdue: r.scheduledAt.getTime() < now.getTime(),
  }));
}

export interface EasyDueRow {
  id: string;
  customerId: string | null;
  customerName: string;
  customerPhone: string | null;
  amount: number;
  paidAmount: number;
  outstanding: number;
  dueDate: string;
  daysOverdue: number;
  status: string;
  notes: string | null;
}

export async function listEasyDues(actor: Actor, opts: { includePaid?: boolean } = {}): Promise<EasyDueRow[]> {
  const now = new Date();
  const rows = await db
    .select({
      id: paymentDue.id,
      customerId: paymentDue.customerId,
      amount: paymentDue.amount,
      paidAmount: paymentDue.paidAmount,
      dueDate: paymentDue.dueDate,
      status: paymentDue.status,
      notes: paymentDue.notes,
      customerName: customers.name,
      customerPhone: customers.phone,
      leadName: leads.name,
    })
    .from(paymentDue)
    .leftJoin(customers, eq(customers.id, paymentDue.customerId))
    .leftJoin(leads, eq(leads.id, paymentDue.leadId))
    .where(
      and(
        dueVisibility(actor),
        opts.includePaid ? inArray(paymentDue.status, ['PENDING', 'PARTIAL', 'PAID']) : inArray(paymentDue.status, ['PENDING', 'PARTIAL']),
      ),
    )
    .orderBy(paymentDue.dueDate);

  return rows.map((r) => {
    const amount = num(r.amount);
    const paid = num(r.paidAmount);
    return {
      id: r.id,
      customerId: r.customerId,
      customerName: r.customerName ?? r.leadName ?? 'Unknown',
      customerPhone: r.customerPhone,
      amount,
      paidAmount: paid,
      outstanding: round2(Math.max(0, amount - paid)),
      dueDate: r.dueDate.toISOString(),
      daysOverdue: Math.floor((now.getTime() - new Date(r.dueDate).getTime()) / DAY_MS),
      status: r.status,
      notes: r.notes,
    };
  });
}

export interface EasyLeadRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  status: string;
  source: string | null;
  ownerName: string | null;
  lastActivityAt: string | null;
  nextFollowUpAt: string | null;
  createdAt: string;
}

export async function listEasyLeads(actor: Actor, opts: { search?: string; limit?: number } = {}): Promise<EasyLeadRow[]> {
  const search = opts.search?.trim();
  const rows = await db
    .select({
      id: leads.id,
      name: leads.name,
      phone: leads.phone,
      email: leads.email,
      status: leads.status,
      source: leads.source,
      createdAt: leads.createdAt,
      ownerName: users.name,
    })
    .from(leads)
    .leftJoin(users, eq(users.id, leads.ownerId))
    .where(
      and(
        leadVisibility(actor),
        search ? or(sql`${leads.name} ilike ${'%' + search + '%'}`, sql`${leads.phone} ilike ${'%' + search + '%'}`) : undefined,
      ),
    )
    .orderBy(sql`${leads.createdAt} desc`)
    .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    phone: r.phone,
    email: r.email,
    status: r.status,
    source: r.source,
    ownerName: r.ownerName,
    lastActivityAt: null,
    nextFollowUpAt: null,
    createdAt: r.createdAt.toISOString(),
  }));
}

export interface EasyPaymentInput {
  dueId?: string;
  customerId?: string;
  leadId?: string;
  amount: number;
  method: string;
  reference?: string;
  notes?: string;
  paymentDate?: string;
}

async function resolveCustomer(actor: Actor, input: EasyPaymentInput): Promise<string> {
  if (input.customerId) return input.customerId;
  if (input.leadId) {
    const linked = await db.query.customers.findFirst({ where: eq(customers.leadId, input.leadId) });
    if (linked) return linked.id;
  }
  throw new ApiError(422, 'Select a customer or lead to record the payment against', 'VALIDATION');
}

/**
 * The easy payment flow parks money against a hidden placeholder DRAFT until an
 * agent attaches a real booking. Those rows are not bookings, so manager-facing
 * reports must not count them — but the payments collected against them are
 * real and stay counted. Single source of truth for that `meta` flag.
 */
export const HIDDEN_DRAFT_META = sql`${bookings.meta} ->> 'hidden' = 'true'`;
export const NOT_HIDDEN_DRAFT = sql`(${bookings.meta} ->> 'hidden') is distinct from 'true'`;

async function resolveBooking(
  actor: Actor,
  customerId: string,
  leadId: string | null,
  bookingId: string | null,
  paymentDate: Date,
): Promise<string> {
  if (bookingId) return bookingId;

  // Only reuse a draft this module created. A real draft a user started in the
  // full UI has a project/unit and a non-zero sale value, so hijacking it would
  // attribute collections to the wrong booking.
  const existing = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.customerId, customerId),
        eq(bookings.status, 'DRAFT'),
        HIDDEN_DRAFT_META,
      ),
    )
    .orderBy(sql`${bookings.createdAt} desc`)
    .limit(1);
  if (existing[0]) return existing[0].id;

  const bookingNo = await nextNumber('booking', 'BK', 4);
  const [created] = await db
    .insert(bookings)
    .values({
      bookingNo,
      customerId,
      leadId,
      projectId: null,
      unitId: null,
      towerId: null,
      saleValue: '0',
      bookingAmount: '0',
      bookingDate: paymentDate,
      status: 'DRAFT',
      meta: { hidden: true, createdBy: 'simple-ui' },
      salespersonId: actor.user.id,
      notes: 'Auto-created to hold a collection recorded from the simple UI',
      createdById: actor.user.id,
    })
    .returning({ id: bookings.id });

  return created.id;
}

export interface EasyPaymentResult {
  paymentId: string;
  receiptNo: string | null;
  bookingId: string;
  dueId: string | null;
  outstandingAfter: number;
  dueSettled: boolean;
}

export async function recordEasyPayment(actor: Actor, raw: EasyPaymentInput): Promise<EasyPaymentResult> {
  const amount = round2(num(raw.amount));
  if (amount <= 0) throw new ApiError(422, 'Amount must be greater than 0', 'VALIDATION');
  if (!raw.method) throw new ApiError(422, 'Payment method is required', 'VALIDATION');

  let due: typeof paymentDue.$inferSelect | null = null;
  if (raw.dueId) {
    due = (await db.select().from(paymentDue).where(and(eq(paymentDue.id, raw.dueId), dueVisibility(actor))).limit(1))[0] ?? null;
    if (!due) throw new ApiError(404, 'Payment due not found', 'NOT_FOUND');
    if (due.status === 'PAID') throw new ApiError(422, 'This payment is already settled', 'VALIDATION');

    const outstanding = round2(Math.max(0, num(due.amount) - num(due.paidAmount)));
    if (amount - outstanding > MONEY_EPSILON) {
      throw new ApiError(422, `Amount exceeds the outstanding balance of ${outstanding.toFixed(2)}`, 'VALIDATION');
    }
  } else if (!raw.customerId && !raw.leadId) {
    throw new ApiError(422, 'Pick a pending payment or choose a customer', 'VALIDATION');
  }

  const customerId = await resolveCustomer(actor, raw);
  const paymentDate = raw.paymentDate ? new Date(raw.paymentDate) : new Date();
  const bookingId = await resolveBooking(actor, customerId, due?.leadId ?? raw.leadId ?? null, due?.bookingId ?? null, paymentDate);

  const result = await recordPayment(actor, {
    bookingId,
    amount,
    method: raw.method,
    reference: raw.reference ?? null,
    paymentDate,
  });

  let outstandingAfter = 0;
  let dueSettled = false;

  if (due) {
    const paid = round2(num(due.paidAmount) + amount);
    const settled = paid + MONEY_EPSILON >= num(due.amount);
    await db
      .update(paymentDue)
      .set({
        paidAmount: String(paid),
        paymentId: result.paymentId,
        status: settled ? 'PAID' : 'PARTIAL',
        paidAt: settled ? paymentDate : null,
        updatedAt: new Date(),
      })
      .where(eq(paymentDue.id, due.id));
    outstandingAfter = round2(Math.max(0, num(due.amount) - paid));
    dueSettled = settled;
  }

  await writeAudit({
    actor,
    action: 'CREATE',
    entity: 'payment',
    entityId: result.paymentId,
    newValue: { amount, method: raw.method, dueId: due?.id ?? null, source: 'easy' },
  });

  return { paymentId: result.paymentId, receiptNo: result.receiptNo, bookingId, dueId: due?.id ?? null, outstandingAfter, dueSettled };
}
