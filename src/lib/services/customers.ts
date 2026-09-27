import { db } from '../db';
import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { Actor } from '../api';
import { ApiError } from '../api';
import type { Customer, CustomerInsert, Lead } from '../db/schema';
import { customers, leads } from '../db/schema';
import { nextNumber } from './counters';
import { customerCreateSchema, customerUpdateSchema } from '../validators';
import { normalizePhone, normalizeEmail } from '../utils';
import { resolveVisibleUserIds } from '../api';
import { writeAudit } from '../audit';

export interface CustomerListFilters {
  search?: string;
  ownerId?: string;
  page: number;
  pageSize: number;
}

export type CustomerWithExtras = Customer & { ownerName: string | null; leadName: string | null; leadNo: string | null; bookings?: unknown[] };

const OWNER_COLS = { id: true, name: true } as const;

export async function listCustomers(actor: Actor, filters: CustomerListFilters): Promise<{ items: CustomerWithExtras[]; total: number }> {
  const ownerIds = await resolveVisibleUserIds(actor.user);
  const conds: any[] = [];
  if (ownerIds) conds.push(inArray(customers.ownerId, ownerIds));
  if (filters.ownerId) conds.push(eq(customers.ownerId, filters.ownerId));
  if (filters.search) {
    const q = `%${filters.search}%`;
    conds.push(
      or(ilike(customers.name, q), ilike(customers.phone, q), ilike(customers.email, q), ilike(customers.customerNo, q)),
    );
  }
  const where = conds.length ? and(...conds) : undefined;

  const rows = await db.query.customers.findMany({
    where,
    with: { owner: { columns: OWNER_COLS }, lead: { columns: { id: true, name: true, leadNo: true } } },
    orderBy: [desc(customers.createdAt)],
    limit: filters.pageSize,
    offset: (filters.page - 1) * filters.pageSize,
  });
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(customers).where(where ?? sql`true`);

  return {
    items: rows.map((r) => ({
      ...(r as unknown as Customer),
      ownerName: r.owner?.name ?? null,
      leadName: r.lead?.name ?? null,
      leadNo: r.lead?.leadNo ?? null,
    })),
    total: count,
  };
}

export async function getCustomer(actor: Actor, id: string): Promise<CustomerWithExtras | null> {
  const ownerIds = await resolveVisibleUserIds(actor.user);
  if (ownerIds && !ownerIds.includes((await getOwnerOfCustomer(id)) ?? '')) {
    const row = await getOwnerOfCustomer(id);
    if (!row || !ownerIds.includes(row)) throw new ApiError(404, 'Customer not found');
  }
  const r = await db.query.customers.findFirst({
    where: eq(customers.id, id),
    with: { owner: { columns: OWNER_COLS }, lead: { columns: { id: true, name: true, leadNo: true } }, bookings: { columns: { id: true, bookingNo: true, saleValue: true, status: true, bookingDate: true } } },
  });
  if (!r) return null;
  const { owner, lead, bookings, ...rest } = r;
  return {
    ...(rest as unknown as Customer),
    ownerName: owner?.name ?? null,
    leadName: lead?.name ?? null,
    leadNo: lead?.leadNo ?? null,
    bookings: bookings as unknown[],
  };
}

async function getOwnerOfCustomer(id: string): Promise<string | null> {
  const row = await db.query.customers.findFirst({ where: eq(customers.id, id), columns: { ownerId: true } });
  return row?.ownerId ?? null;
}

/** Convert a lead into a customer record (used at booking time). */
export async function convertLeadToCustomer(actor: Actor, lead: Lead): Promise<Customer> {
  const existing = await db.query.customers.findFirst({ where: eq(customers.leadId, lead.id) });
  if (existing) return existing;
  const customerNo = await nextNumber('customer', 'CU');
  const [created] = await db
    .insert(customers)
    .values({
      customerNo,
      leadId: lead.id,
      name: lead.name,
      phone: lead.phone,
      whatsapp: lead.whatsapp,
      email: lead.email,
      ownerId: lead.ownerId,
      notes: `Converted from lead ${lead.leadNo}`,
    })
    .returning();
  await writeAudit({ actor, action: 'CREATE', entity: 'customer', entityId: created.id, newValue: { customerNo, fromLead: lead.leadNo } });
  return created;
}

export async function createCustomer(actor: Actor, rawData: unknown): Promise<Customer> {
  const data = customerCreateSchema.parse(rawData);
  const customerNo = await nextNumber('customer', 'CU');
  const lead = data.leadId ? await db.query.leads.findFirst({ where: eq(leads.id, data.leadId) }) : null;

  const insert: CustomerInsert = {
    customerNo,
    leadId: data.leadId ?? null,
    name: data.name,
    phone: data.phone ? normalizePhone(data.phone) : null,
    whatsapp: data.whatsapp ? normalizePhone(data.whatsapp) ?? data.whatsapp : null,
    email: data.email ? normalizeEmail(data.email) : null,
    pan: data.pan ?? null,
    aadhaar: data.aadhaar ?? null,
    address: data.address ?? null,
    city: data.city ?? null,
    state: data.state ?? null,
    pincode: data.pincode ?? null,
    ownerId: data.ownerId ?? lead?.ownerId ?? null,
    tags: data.tags ?? [],
    notes: data.notes ?? null,
  };
  const [created] = await db.insert(customers).values(insert).returning();
  await writeAudit({ actor, action: 'CREATE', entity: 'customer', entityId: created.id, newValue: { customerNo } });
  return created;
}

export async function updateCustomer(actor: Actor, id: string, rawData: unknown): Promise<Customer | null> {
  const data = customerUpdateSchema.parse(rawData);
  const existing = await db.query.customers.findFirst({ where: eq(customers.id, id) });
  if (!existing) throw new ApiError(404, 'Customer not found');

  const patch: Record<string, unknown> = {};
  if (data.name !== undefined) patch.name = data.name;
  if (data.phone !== undefined) patch.phone = data.phone ? normalizePhone(data.phone) : null;
  if (data.whatsapp !== undefined) patch.whatsapp = data.whatsapp ? normalizePhone(data.whatsapp) ?? data.whatsapp : null;
  if (data.email !== undefined) patch.email = data.email ? normalizeEmail(data.email) : null;
  if (data.pan !== undefined) patch.pan = data.pan ?? null;
  if (data.aadhaar !== undefined) patch.aadhaar = data.aadhaar ?? null;
  if (data.address !== undefined) patch.address = data.address ?? null;
  if (data.city !== undefined) patch.city = data.city ?? null;
  if (data.state !== undefined) patch.state = data.state ?? null;
  if (data.pincode !== undefined) patch.pincode = data.pincode ?? null;
  if (data.ownerId !== undefined) patch.ownerId = data.ownerId ?? null;
  if (data.tags !== undefined) patch.tags = data.tags;
  if (data.notes !== undefined) patch.notes = data.notes ?? null;

  const [updated] = await db.update(customers).set({ ...patch, updatedAt: new Date() }).where(eq(customers.id, id)).returning();
  await writeAudit({ actor, action: 'UPDATE', entity: 'customer', entityId: id, oldValue: existing, newValue: updated });
  return updated ?? null;
}

export async function deleteCustomer(actor: Actor, id: string): Promise<void> {
  await db.delete(customers).where(eq(customers.id, id));
  await writeAudit({ actor, action: 'DELETE', entity: 'customer', entityId: id });
}

export async function searchCustomers(actor: Actor, q: string, limit = 6): Promise<CustomerWithExtras[]> {
  const ownerIds = await resolveVisibleUserIds(actor.user);
  const where = ownerIds
    ? and(inArray(customers.ownerId, ownerIds), or(ilike(customers.name, `%${q}%`), ilike(customers.phone, `%${q}%`), ilike(customers.customerNo, `%${q}%`)))
    : or(ilike(customers.name, `%${q}%`), ilike(customers.phone, `%${q}%`), ilike(customers.customerNo, `%${q}%`));
  const rows = await db.query.customers.findMany({ where, limit, orderBy: [desc(customers.createdAt)] });
  return rows.map((r) => ({
    ...(r as unknown as Customer),
    ownerName: null,
    leadName: null,
    leadNo: null,
  }));
}