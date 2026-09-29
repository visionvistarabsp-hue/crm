import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
  bookings,
  customerActivities,
  customers,
  documents,
  leads,
  payments,
  projects,
  users,
} from '@/lib/db/schema';
import { ApiError, type Actor } from '@/lib/api';
import { resolveVisibleUserIds } from '@/lib/api';
import { writeAudit } from '@/lib/audit';

export type TimelineKind = 'ACTIVITY' | 'BOOKING' | 'PAYMENT' | 'DOCUMENT';

export interface TimelineEntry {
  id: string;
  kind: TimelineKind;
  /** Short label shown as the timeline title, e.g. "Payment received". */
  title: string;
  detail: string | null;
  at: string;
  /** Money attached to the event, already as a number for the UI to format. */
  amount: number | null;
  status: string | null;
  refId: string;
  actorName: string | null;
}

/** Postgres `numeric` arrives as a string; anything unusable counts as zero. */
function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Merge the per-table event lists into one reverse-chronological timeline.
 *
 * Bounced and reversed payments are dropped: an agent reading a customer
 * history wants what actually happened to the money, and a reversal is not
 * something they paid. The reversal itself remains visible in the ledger.
 */
export function buildTimeline(
  events: Array<Omit<TimelineEntry, 'at'> & { at: Date | string | null }>,
): TimelineEntry[] {
  return events
    .filter((e) => e.at !== null)
    .map((e) => ({ ...e, at: iso(e.at) as string }))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

function filterPayments<T extends { status: string }>(rows: T[]): T[] {
  return rows.filter((r) => r.status !== 'BOUNCED' && r.status !== 'REVERSED');
}

export interface Customer360 {
  customer: typeof customers.$inferSelect & { ownerName: string | null };
  lead: { id: string; leadNo: string; name: string; status: string; source: string | null } | null;
  projects: Array<{ id: string; name: string; code: string }>;
  summary: {
    bookingCount: number;
    activeBookings: number;
    totalSaleValue: number;
    totalReceived: number;
    totalOutstanding: number;
    documentCount: number;
    pendingDocuments: number;
  };
  timeline: TimelineEntry[];
}

/**
 * Everything about one customer in a single call: identity, the inventory they
 * are attached to, money position, and a merged history across bookings,
 * payments, documents and free-form notes.
 */
export async function getCustomer360(actor: Actor, id: string): Promise<Customer360> {
  const customer = await db.query.customers.findFirst({
    where: eq(customers.id, id),
    columns: {
      id: true, customerNo: true, leadId: true, name: true, phone: true, whatsapp: true,
      email: true, pan: true, aadhaar: true, address: true, city: true, state: true,
      pincode: true, ownerId: true, tags: true, notes: true, metadata: true,
      createdAt: true, updatedAt: true,
    },
    with: { owner: { columns: { id: true, name: true } } },
  });
  if (!customer) throw new ApiError(404, 'Customer not found');

  // Row-level visibility has to be checked before any related record is read,
  // otherwise the timeline leaks data about customers the actor cannot see.
  const ownerIds = await resolveVisibleUserIds(actor.user);
  if (ownerIds && !ownerIds.includes(customer.ownerId ?? '')) {
    throw new ApiError(404, 'Customer not found');
  }

  const [bookingRows, paymentRows, documentRows, activityRows] = await Promise.all([
    db.query.bookings.findMany({
      where: eq(bookings.customerId, id),
      columns: {
        id: true, bookingNo: true, saleValue: true, bookingDate: true, status: true,
        projectId: true, salespersonId: true,
      },
      with: {
        project: { columns: { id: true, name: true, code: true } },
        salesperson: { columns: { id: true, name: true } },
      },
      orderBy: [desc(bookings.bookingDate)],
    }),
    db.query.payments.findMany({
      where: eq(payments.customerId, id),
      columns: {
        id: true, amount: true, paymentDate: true, status: true, receiptNo: true,
        receivedById: true, bookingId: true,
      },
      with: { receivedBy: { columns: { id: true, name: true } } },
      orderBy: [desc(payments.paymentDate)],
    }),
    db.query.documents.findMany({
      where: eq(documents.customerId, id),
      columns: { id: true, documentType: true, fileName: true, verificationStatus: true, createdAt: true, uploadedById: true },
      with: { uploader: { columns: { id: true, name: true } } },
      orderBy: [desc(documents.createdAt)],
    }),
    db.query.customerActivities.findMany({
      where: eq(customerActivities.customerId, id),
      columns: { id: true, type: true, note: true, createdAt: true, performedById: true },
      with: { customer: { columns: { id: true } } },
      orderBy: [desc(customerActivities.createdAt)],
    }),
  ]);

  const lead = customer.leadId
    ? await db.query.leads.findFirst({
        where: eq(leads.id, customer.leadId),
        columns: { id: true, leadNo: true, name: true, status: true, source: true },
      })
    : null;

  const seenProjects = new Map<string, { id: string; name: string; code: string }>();
  for (const b of bookingRows) {
    if (b.project) seenProjects.set(b.project.id, b.project);
  }

  const settled = filterPayments(paymentRows);
  const totalReceived = settled.reduce((sum, p) => sum + toNumber(p.amount), 0);
  const totalSaleValue = bookingRows.reduce((sum, b) => sum + toNumber(b.saleValue), 0);

  const events: Array<Omit<TimelineEntry, 'at'> & { at: Date | string | null }> = [
    ...activityRows.map((a) => ({
      id: `act-${a.id}`,
      kind: 'ACTIVITY' as const,
      title: a.type,
      detail: a.note,
      amount: null,
      status: null,
      refId: a.id,
      actorName: null,
      at: a.createdAt,
    })),
    ...bookingRows.map((b) => ({
      id: `bkg-${b.id}`,
      kind: 'BOOKING' as const,
      title: `Booking ${b.bookingNo}`,
      detail: b.project ? `${b.project.name} (${b.project.code})` : null,
      amount: toNumber(b.saleValue),
      status: b.status,
      refId: b.id,
      actorName: b.salesperson?.name ?? null,
      at: b.bookingDate,
    })),
    ...settled.map((p) => ({
      id: `pay-${p.id}`,
      kind: 'PAYMENT' as const,
      title: p.status === 'RECEIVED' ? 'Payment received' : `Payment ${p.status.toLowerCase()}`,
      detail: p.receiptNo,
      amount: toNumber(p.amount),
      status: p.status,
      refId: p.id,
      actorName: p.receivedBy?.name ?? null,
      at: p.paymentDate,
    })),
    ...documentRows.map((d) => ({
      id: `doc-${d.id}`,
      kind: 'DOCUMENT' as const,
      title: d.documentType,
      detail: d.fileName,
      amount: null,
      status: d.verificationStatus,
      refId: d.id,
      actorName: d.uploader?.name ?? null,
      at: d.createdAt,
    })),
    ];

  return {
    customer: { ...(customer as typeof customers.$inferSelect), ownerName: customer.owner?.name ?? null },
    lead: lead
      ? { id: lead.id, leadNo: lead.leadNo, name: lead.name, status: lead.status, source: lead.source ?? null }
      : null,
    projects: [...seenProjects.values()],
    summary: {
      bookingCount: bookingRows.length,
      activeBookings: bookingRows.filter((b) => b.status !== 'CANCELLED').length,
      totalSaleValue,
      totalReceived,
      totalOutstanding: Math.max(0, totalSaleValue - totalReceived),
      documentCount: documentRows.length,
      pendingDocuments: documentRows.filter((d) => d.verificationStatus === 'PENDING').length,
    },
    timeline: buildTimeline(events),
  };
}

/** Append a free-form note to a customer's history. */
export async function addCustomerActivity(
  actor: Actor,
  customerId: string,
  rawData: unknown,
): Promise<typeof customerActivities.$inferSelect> {
  const note = typeof (rawData as { note?: unknown })?.note === 'string'
    ? String((rawData as { note?: unknown }).note).trim()
    : '';
  if (!note) throw new ApiError(400, 'Note is required');
  if (note.length > 2000) throw new ApiError(400, 'Note is too long');

  const existing = await db.query.customers.findFirst({
    where: eq(customers.id, customerId),
    columns: { id: true, ownerId: true },
  });
  if (!existing) throw new ApiError(404, 'Customer not found');

  const ownerIds = await resolveVisibleUserIds(actor.user);
  if (ownerIds && !ownerIds.includes(existing.ownerId ?? '')) {
    throw new ApiError(404, 'Customer not found');
  }

  const [row] = await db
    .insert(customerActivities)
    .values({ customerId, type: 'NOTE', note, performedById: actor.user.id })
    .returning();
  if (!row) throw new ApiError(500, 'Could not save the note');

  await writeAudit({ actor, action: 'CREATE', entity: 'customer_activity', entityId: row.id, newValue: { noteLength: note.length } });
  return row;
}

export const __testables = { toNumber, iso, filterPayments };
