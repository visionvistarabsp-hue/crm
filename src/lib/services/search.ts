import { db } from '../db';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { Actor } from '../api';
import { leads, customers, bookings, documents, projects, units } from '../db/schema';
import { resolveVisibleUserIds } from '../api';

export interface SearchResult {
  leads: Array<{ id: string; label: string; subtitle: string }>;
  customers: Array<{ id: string; label: string; subtitle: string }>;
  bookings: Array<{ id: string; label: string; subtitle: string }>;
  documents: Array<{ id: string; label: string; subtitle: string }>;
  projects: Array<{ id: string; label: string; subtitle: string }>;
}

/**
 * Global quick search. Scoped to the actor's visibility for leads.
 */
export async function globalSearch(actor: Actor, term: string, limit = 5): Promise<SearchResult> {
  const q = `%${term.trim()}%`;
  const like = (cols: any[]) => or(...cols.map((c) => sql`${c} ILIKE ${q}`));

  const ownerIds = await resolveVisibleUserIds(actor.user);
  const leadWhere = ownerIds ? and(like([leads.name, leads.phone, leads.email, leads.leadNo]), inArray(leads.ownerId, ownerIds)) : like([leads.name, leads.phone, leads.email, leads.leadNo]);

  const [leadRows, customerRows, bookingRows, documentRows, projectRows] = await Promise.all([
    db.select({ id: leads.id, name: leads.name, contact: leads.phone, no: leads.leadNo, status: leads.status }).from(leads).where(leadWhere).limit(limit).orderBy(leads.updatedAt),
    db.select({ id: customers.id, name: customers.name, contact: customers.phone, no: customers.customerNo }).from(customers).where(like([customers.name, customers.phone, customers.email, customers.customerNo])).limit(limit).orderBy(customers.updatedAt),
    db.select({ id: bookings.id, no: bookings.bookingNo, status: bookings.status, customer: bookings.customerId }).from(bookings).where(like([bookings.bookingNo, bookings.id])).limit(limit).orderBy(bookings.updatedAt),
    db.select({ id: documents.id, title: documents.title, fileName: documents.fileName, type: documents.documentType, status: documents.verificationStatus }).from(documents).where(like([documents.fileName, documents.title, documents.id])).limit(limit).orderBy(documents.updatedAt),
    db.select({ id: projects.id, code: projects.code, name: projects.name, location: projects.location }).from(projects).where(like([projects.name, projects.code, projects.location])).limit(limit),
  ]);

  return {
    leads: leadRows.map((r) => ({ id: r.id, label: r.name, subtitle: `${r.contact ?? ''} · ${r.status}`, href: `/leads/${r.id}` })),
    customers: customerRows.map((r) => ({ id: r.id, label: r.name, subtitle: r.contact ?? r.no, href: `/customers/${r.id}` })),
    bookings: bookingRows.map((r) => ({ id: r.id, label: r.no, subtitle: `${r.status} · ${r.customer ?? ''}`, href: `/bookings/${r.id}` })),
    documents: documentRows.map((r) => ({ id: r.id, label: r.title ?? r.fileName, subtitle: `${r.type} · ${r.status}`, href: `/documents/${r.id}` })),
    projects: projectRows.map((r) => ({ id: r.id, label: r.name, subtitle: r.code, href: `/projects/${r.id}` })),
  };
}

/** Quick lookup of inventory matching a search (used on booking form). */
export async function searchUnits(actor: Actor, term: string, projectId?: string, excludeStatus?: string[]) {
  const conds: any[] = [
    sql`${units.unitNo} ILIKE ${`%${term.trim()}%`} OR ${units.bhk} ILIKE ${`%${term.trim()}%`}`,
  ];
  if (projectId) conds.push(eq(units.projectId, projectId));
  if (excludeStatus?.length) conds.push(sql`${units.status} NOT IN (${sql.join(excludeStatus.map((s) => sql`${s}`), sql`, `)})`);
  return db
    .select({ id: units.id, unitNo: units.unitNo, bhk: units.bhk, floor: units.floor, price: units.price, status: units.status, projectName: projects.name })
    .from(units)
    .leftJoin(projects, eq(units.projectId, projects.id))
    .where(and(...conds))
    .limit(20);
}