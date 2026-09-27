import { db } from '../db';
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { Actor } from '../api';
import { ApiError } from '../api';
import type { Booking, Customer, Lead } from '../db/schema';
import { bookings, units, customers, leads, leadActivities, leadStatusHistory, payments, cancellations, refunds } from '../db/schema';
import { nextNumber } from './counters';
import { bookingCreateSchema, bookingUpdateSchema, paymentCreateSchema, cancellationCreateSchema, cancellationApproveSchema, refundCreateSchema } from '../validators';
import { convertLeadToCustomer, createCustomer } from './customers';
import { createBookingCommissions, reverseBookingCommissions } from './commissions';
import { resolveVisibleUserIds } from '../api';
import { writeAudit } from '../audit';
import { runAutomations } from './automation';
import { notifyUser, notifyTeam } from '../notifications';

const num = (v: number | string | null | undefined): number => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return isNaN(Number(n)) ? 0 : Number(n);
};

export interface BookingListFilters {
  status?: string;
  projectId?: string;
  salespersonId?: string;
  customerId?: string;
  from?: string;
  to?: string;
  search?: string;
  page: number;
  pageSize: number;
}

const BOOKING_WITH = {
  customer: { columns: { id: true, name: true, phone: true, email: true } },
  project: { columns: { id: true, name: true, code: true } },
  tower: { columns: { id: true, name: true } },
  unit: { columns: { id: true, unitNo: true, bhk: true, floor: true } },
  salesperson: { columns: { id: true, name: true } },
  payments: { orderBy: (p: any, { desc: d }: any) => [d(p.paymentDate)] },
  cancellations: true,
  commissionSnapshots: true,
} as const;

export async function listBookings(actor: Actor, f: BookingListFilters): Promise<{ items: Booking[]; total: number }> {
  const ownerIds = await resolveVisibleUserIds(actor.user);
  const conds: any[] = [];
  if (ownerIds) conds.push(inArray(bookings.salespersonId, ownerIds));
  if (f.status) conds.push(eq(bookings.status, f.status));
  if (f.projectId) conds.push(eq(bookings.projectId, f.projectId));
  if (f.salespersonId) conds.push(eq(bookings.salespersonId, f.salespersonId));
  if (f.customerId) conds.push(eq(bookings.customerId, f.customerId));
  if (f.from) conds.push(gte(bookings.bookingDate, new Date(f.from)));
  if (f.to) conds.push(lte(bookings.bookingDate, new Date(f.to)));
  if (f.search) conds.push(sql`${bookings.bookingNo} ILIKE ${`%${f.search}%`}`);

  const where = conds.length ? and(...conds) : undefined;
  const rows = await db.query.bookings.findMany({ where, with: BOOKING_WITH, orderBy: [desc(bookings.bookingDate)], limit: f.pageSize, offset: (f.page - 1) * f.pageSize });
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(bookings).where(where ?? sql`true`);
  return { items: rows.map(toBookingView), total: count };
}

function toBookingView(b: any) {
  return {
    ...b,
    customerName: b.customer?.name ?? null,
    customerPhone: b.customer?.phone ?? null,
    projectName: b.project?.name ?? null,
    towerName: b.tower?.name ?? null,
    unitNo: b.unit?.unitNo ?? null,
    salespersonName: b.salesperson?.name ?? null,
  };
}

export async function getBooking(actor: Actor, id: string) {
  const rows = await db.query.bookings.findFirst({ where: eq(bookings.id, id), with: BOOKING_WITH });
  if (!rows) return null;
  const view = toBookingView(rows);
  return view;
}

async function resolveCustomerPlaceholder(): Promise<void> {
  // (reserved for future multi-customer bookings)
}

/**
 * Create a booking atomically:
 *  - locks the unit, converts the lead to a customer,
 *  - writes commission snapshots (versioned),
 *  - marks inventory and updates the lead pipeline.
 */
export async function createBooking(actor: Actor, rawData: unknown): Promise<Booking> {
  const data = bookingCreateSchema.parse(rawData);

  let created: Booking | undefined;
  let linkedLead: Lead | null = null;
  let linkedCustomer: Customer | null = null;

  await db.transaction(async (tx) => {
    // 1. lock unit
    if (data.unitId) {
      const locks = await tx.select().from(units).where(eq(units.id, data.unitId)).for('update');
      if (!locks.length) throw new ApiError(422, 'Unit not found');
      const unit = locks[0];
      if (!['AVAILABLE', 'HOLD'].includes(unit.status)) {
        throw new ApiError(422, `Unit ${unit.unitNo} is not available (${unit.status})`);
      }
    }

    // 2. customer resolution (existing / lead conversion / new)
    if (data.customerId) {
      linkedCustomer = await tx.query.customers.findFirst({ where: eq(customers.id, data.customerId) }) ?? null;
      if (!linkedCustomer) throw new ApiError(422, 'Customer not found');
    } else if (data.leadId) {
      linkedLead = await tx.query.leads.findFirst({ where: eq(leads.id, data.leadId) }) ?? null;
      if (!linkedLead) throw new ApiError(422, 'Lead not found');
      linkedCustomer = await convertLeadToCustomer(actor, linkedLead);
    } else if (data.newCustomer?.name) {
      linkedCustomer = await createCustomer(actor, data.newCustomer);
    }
    if (!linkedCustomer) throw new ApiError(422, 'A customer or lead is required');

    // 3. booking record
    const bookingNo = await nextNumber('booking', 'BK', 4, tx);
    const [booked] = await tx
      .insert(bookings)
      .values({
        bookingNo,
        customerId: linkedCustomer.id,
        leadId: linkedLead?.id ?? null,
        projectId: data.projectId,
        towerId: data.towerId ?? null,
        unitId: data.unitId ?? null,
        saleValue: String(data.saleValue),
        bookingAmount: String(data.bookingAmount ?? '0'),
        paymentDetails: data.paymentDetails ?? {},
        salespersonId: data.salespersonId ?? linkedLead?.ownerId ?? null,
        teamLeaderId: data.teamLeaderId ?? null,
        brokerId: data.brokerId ?? null,
        brokerName: data.brokerName ?? null,
        bookingDate: data.bookingDate instanceof Date ? data.bookingDate : new Date(data.bookingDate),
        status: 'CONFIRMED',
        notes: data.notes ?? null,
        createdById: actor.user.id,
      })
      .returning();
    created = booked;

    // 4. mark inventory
    if (data.unitId) {
      await tx.update(units).set({ status: 'BOOKED', bookingId: booked.id, customerId: linkedCustomer.id, updatedAt: new Date() }).where(eq(units.id, data.unitId));
    }

    // 5. initial payment (booking amount received)
    if (num(data.bookingAmount) > 0) {
      await tx.insert(payments).values({
        bookingId: booked.id,
        customerId: linkedCustomer.id,
        amount: String(data.bookingAmount),
        paymentDate: new Date(),
        method: 'BANK_TRANSFER',
        reference: 'Booking amount',
        status: 'RECEIVED',
        receivedById: actor.user.id,
      });
    }

    // 6. commission snapshots + ledger (also inside the tx)
    await createBookingCommissions(actor.user.id, booked, tx);

    // 7. lead pipeline / customer linkage
    if (linkedLead) {
      await tx.update(leads).set({ status: 'BOOKING', updatedAt: new Date() }).where(eq(leads.id, linkedLead.id));
      await tx.insert(leadStatusHistory).values({ leadId: linkedLead.id, fromStatus: 'FOLLOW_UP', toStatus: 'BOOKING', changedById: actor.user.id });
      await tx.insert(leadActivities).values({ leadId: linkedLead.id, type: 'BOOKING', note: `Booking ${bookingNo} created (₹${num(data.saleValue).toLocaleString('en-IN')})`, performedById: actor.user.id, meta: { bookingId: booked.id, bookingNo } });
    }

    // link customer back to lead if newCustomer path
    if (!linkedCustomer.leadId && linkedLead) {
      await tx.update(customers).set({ leadId: linkedLead.id, updatedAt: new Date() }).where(eq(customers.id, linkedCustomer.id));
    }
  });

  if (!created) throw new ApiError(500, 'Failed to create booking');
  linkedCustomer = linkedCustomer ?? (await db.query.customers.findFirst({ where: eq(customers.id, created.customerId) }) ?? null);

  await writeAudit({ actor, action: 'CREATE', entity: 'booking', entityId: created.id, newValue: { bookingNo: created.bookingNo, saleValue: created.saleValue, customerId: created.customerId, unitId: created.unitId } });
  await notifyTeam({ type: 'BOOKING_EVENT', title: 'New booking', body: `${created.bookingNo} — ${linkedCustomer?.name ?? ''}`, entityType: 'booking', entityId: created.id });
  await runAutomations('BOOKING_COMPLETED', { bookingId: created.id, customerId: created.customerId, leadId: created.leadId ?? undefined }, actor).catch(() => null);

  return created;
}

export async function updateBooking(actor: Actor, id: string, rawData: unknown): Promise<Booking | null> {
  const data = bookingUpdateSchema.parse(rawData);
  const existing = await db.query.bookings.findFirst({ where: eq(bookings.id, id) });
  if (!existing) throw new ApiError(404, 'Booking not found');

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (data.notes !== undefined) patch.notes = data.notes ?? null;
  if (data.paymentDetails !== undefined) patch.paymentDetails = data.paymentDetails;
  if (data.saleValue !== undefined) patch.saleValue = String(data.saleValue);
  if (data.bookingAmount !== undefined) patch.bookingAmount = String(data.bookingAmount);

  const valueChanged = data.saleValue !== undefined || data.bookingAmount !== undefined;
  if (valueChanged && existing.status !== 'CANCELLED') {
    // recompute commissions: reverse old, snapshot new (historical immutability)
    await db.transaction(async (tx) => {
      await reverseBookingCommissions(actor, existing.id, 'Booking amount adjusted', tx);
    });
  }

  const [updated] = await db.update(bookings).set(patch).where(eq(bookings.id, id)).returning();
  if (valueChanged && updated) {
    await createBookingCommissions(actor.user.id, updated);
    await writeAudit({ actor, action: 'UPDATE', entity: 'booking', entityId: id, oldValue: { saleValue: existing.saleValue, bookingAmount: existing.bookingAmount }, newValue: { saleValue: updated.saleValue, bookingAmount: updated.bookingAmount } });
  } else {
    await writeAudit({ actor, action: 'UPDATE', entity: 'booking', entityId: id });
  }
  return updated ?? null;
}

export async function createPayment(actor: Actor, bookingId: string, rawData: unknown) {
  const data = paymentCreateSchema.parse(rawData);
  const booking = await db.query.bookings.findFirst({ where: eq(bookings.id, bookingId) });
  if (!booking) throw new ApiError(404, 'Booking not found');

  const [payment] = await db.insert(payments).values({
    bookingId,
    customerId: booking.customerId,
    amount: String(data.amount),
    paymentDate: data.paymentDate instanceof Date ? data.paymentDate : new Date(data.paymentDate),
    method: data.method,
    reference: data.reference ?? null,
    status: 'RECEIVED',
    notes: data.notes ?? null,
    receivedById: actor.user.id,
  }).returning();

  if (booking.leadId) {
    await db.insert(leadActivities).values({
      leadId: booking.leadId,
      type: 'PAYMENT',
      note: `Payment received: ₹${num(data.amount).toLocaleString('en-IN')} (${data.method})`,
      performedById: actor.user.id,
      meta: { paymentId: payment.id, bookingId },
    });
  }
  await notifyUser(actor.user.id, { type: 'PAYMENT_REMINDER' as any, title: 'Payment recorded', body: `₹${num(data.amount).toLocaleString('en-IN')} on ${booking.bookingNo}`, entityType: 'booking', entityId: bookingId });
  await writeAudit({ actor, action: 'CREATE', entity: 'payment', entityId: payment.id, newValue: { amount: payment.amount, method: payment.method } });
  return payment;
}

// ------------------------------------------------------------------
// Cancellation workflow
// ------------------------------------------------------------------

/** Register a cancellation request (needs approval before inventory/commission impact). */
export async function requestCancellation(actor: Actor, bookingId: string, rawData: unknown) {
  const data = cancellationCreateSchema.parse(rawData);
  const booking = await db.query.bookings.findFirst({ where: eq(bookings.id, bookingId) });
  if (!booking) throw new ApiError(404, 'Booking not found');
  if (booking.status === 'CANCELLED') throw new ApiError(422, 'Booking already cancelled');

  const [cancellation] = await db.insert(cancellations).values({
    bookingId,
    reason: data.reason,
    reasonCategory: data.reasonCategory,
    cancelledAt: data.cancelledAt instanceof Date ? data.cancelledAt : new Date(data.cancelledAt),
    refundAmount: String(data.refundAmount ?? '0'),
    refundStatus: data.refundStatus,
    approvalStatus: 'PENDING',
    notes: data.notes ?? null,
    createdById: actor.user.id,
  }).returning();

  if (booking.leadId) {
    await db.insert(leadActivities).values({
      leadId: booking.leadId,
      type: 'CANCELLATION',
      note: `Cancellation requested: ${data.reason}`,
      performedById: actor.user.id,
      meta: { bookingId, cancellationId: cancellation.id },
    });
  }
  await writeAudit({ actor, action: 'UPDATE', entity: 'booking', entityId: bookingId, newValue: { approvalStatus: 'PENDING' } });
  await notifyUser(actor.user.id, { type: 'BOOKING_EVENT', title: 'Cancellation requested', body: `${booking.bookingNo}: ${data.reason}`, entityType: 'cancellation', entityId: cancellation.id });
  return cancellation;
}

/**
 * Approve / reject a cancellation. Approval releases inventory,
 * reverses commissions, triggers refunds and updates the pipeline.
 */
export async function approveCancellation(actor: Actor, cancellationId: string, rawData: unknown) {
  const data = cancellationApproveSchema.parse(rawData);
  const cancellation = await db.query.cancellations.findFirst({ where: eq(cancellations.id, cancellationId) });
  if (!cancellation) throw new ApiError(404, 'Cancellation not found');
  if (cancellation.approvalStatus === 'APPROVED' || cancellation.approvalStatus === 'REJECTED') {
    throw new ApiError(422, `Cancellation already ${cancellation.approvalStatus}`);
  }
  const booking = await db.query.bookings.findFirst({ where: eq(bookings.id, cancellation.bookingId) });
  if (!booking) throw new ApiError(404, 'Booking not found');

  if (!data.approved) {
    await db.update(cancellations).set({ approvalStatus: 'REJECTED', approvedById: actor.user.id, approvedAt: new Date(), notes: data.note ? `${cancellation.notes ?? ''}\nRejected: ${data.note}` : cancellation.notes, updatedAt: new Date() }).where(eq(cancellations.id, cancellationId));
    await writeAudit({ actor, action: 'APPROVE', entity: 'cancellation', entityId: cancellationId, newValue: { approved: false } });
    return { cancellation, booking, approved: false };
  }

  await db.transaction(async (tx) => {
    await tx.update(cancellations).set({ approvalStatus: 'APPROVED', approvedById: actor.user.id, approvedAt: new Date(), inventoryProcessed: true, commissionProcessed: true, updatedAt: new Date() }).where(eq(cancellations.id, cancellationId));

    // inventory release
    if (booking.unitId) {
      await tx.update(units).set({ status: 'AVAILABLE', bookingId: null, customerId: null, updatedAt: new Date() }).where(eq(units.id, booking.unitId));
    }
    await tx.update(bookings).set({ status: 'CANCELLED', cancellationId, updatedAt: new Date() }).where(eq(bookings.id, booking.id));

    // refunds
    if (num(cancellation.refundAmount) > 0) {
      await tx.insert(refunds).values({
        cancellationId,
        bookingId: booking.id,
        amount: String(cancellation.refundAmount),
        date: new Date(),
        status: cancellation.refundStatus,
        notes: 'Auto-created on cancellation approval',
        createdById: actor.user.id,
      });
    }

    // commission reversals
    await reverseBookingCommissions(actor, booking.id, cancellation.reason, tx);

    // lead pipeline
    if (booking.leadId) {
      await tx.update(leads).set({ status: 'CANCELLED', updatedAt: new Date() }).where(eq(leads.id, booking.leadId));
      await tx.insert(leadStatusHistory).values({ leadId: booking.leadId, fromStatus: 'BOOKING', toStatus: 'CANCELLED', changedById: actor.user.id, reason: cancellation.reason });
      await tx.insert(leadActivities).values({ leadId: booking.leadId, type: 'CANCELLATION', note: `Booking ${booking.bookingNo} cancelled: ${cancellation.reason}`, performedById: actor.user.id, meta: { bookingId: booking.id } });
    }
  });

  await writeAudit({ actor, action: 'CANCEL', entity: 'booking', entityId: booking.id, oldValue: { status: booking.status }, newValue: { status: 'CANCELLED', cancellationId } });
  await notifyUser(actor.user.id, { type: 'BOOKING_EVENT', title: 'Booking cancelled', body: `${booking.bookingNo} was cancelled`, entityType: 'booking', entityId: booking.id });
  return { cancellation: (await db.query.cancellations.findFirst({ where: eq(cancellations.id, cancellationId) }))!, booking: (await db.query.bookings.findFirst({ where: eq(bookings.id, booking.id) }))!, approved: true };
}

export async function listCancellations(actor: Actor, statusFilter?: string) {
  const where = statusFilter ? eq(cancellations.approvalStatus, statusFilter) : undefined;
  const rows = await db.query.cancellations.findMany({
    where,
    with: { booking: { columns: { id: true, bookingNo: true, saleValue: true, customerId: true } }, refunds: true },
    orderBy: [desc(cancellations.createdAt)],
  });
  return rows;
}

export async function createRefund(actor: Actor, rawData: unknown) {
  const data = refundCreateSchema.parse(rawData);
  const [refund] = await db.insert(refunds).values({
    cancellationId: (data as any).cancellationId ?? null,
    bookingId: (data as any).bookingId ?? null,
    amount: String(data.amount),
    date: data.date instanceof Date ? data.date : new Date(data.date),
    method: data.method,
    reference: data.reference ?? null,
    status: 'PENDING',
    notes: data.notes ?? null,
    createdById: actor.user.id,
  }).returning();
  await writeAudit({ actor, action: 'CREATE', entity: 'refund', entityId: refund.id, newValue: { amount: refund.amount } });
  return refund;
}

export { num as bookingNum };