import { db } from '../db';
import { and, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Actor } from '../api';
import { leads, meetings, bookings, payments, customers, users, commissionSnapshots, cancellations, projects } from '../db/schema';
import { resolveVisibleUserIds } from '../api';

const num = (v: number | string | null | undefined): number => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return isNaN(Number(n)) ? 0 : Number(n);
};

const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

const DAY_MS = 86_400_000;

/**
 * Parse a filter date into a Date, or null when it is absent/unparseable.
 * A bare `YYYY-MM-DD` is anchored to UTC midnight; a full ISO string is
 * honoured as given. Returning null for junk matters: passing an
 * `Invalid Date` into a comparison silently widens or empties a range
 * instead of failing loudly.
 */
function parseDay(v?: string): Date | null {
  if (!v) return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? `${v.trim()}T00:00:00.000Z` : v.trim();
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Exclusive upper bound for an inclusive `to` date: the midnight AFTER the
 * requested day. `2026-01-31` therefore covers all of Jan 31 and stops at
 * Feb 1 00:00. Date arithmetic rolls month and year boundaries correctly.
 */
function endExclusive(v?: string): Date | null {
  const d = parseDay(v);
  return d ? new Date(d.getTime() + DAY_MS) : null;
}

/**
 * Half-open date window [from, to+1day) applied to `column`.
 * Returns undefined when neither bound is usable, so it composes with `and()`.
 */
function rangeCond(column: AnyPgColumn, filters: DashboardFilters) {
  const from = parseDay(filters.from);
  const to = endExclusive(filters.to);
  return and(from ? gte(column, from) : undefined, to ? lt(column, to) : undefined);
}

/** Aggregates by calendar month for charts. */
export async function getTrendSeries(actor: Actor, months = 6, projectId?: string) {
  const from = new Date();
  from.setUTCMonth(from.getUTCMonth() - months + 1, 1);
  from.setUTCHours(0, 0, 0, 0);

  const ownerIds = await resolveVisibleUserIds(actor.user);
  const ownerCond = ownerIds ? inArray(leads.ownerId, ownerIds) : undefined;
  const projCond = projectId ? eq(leads.projectId, projectId) : undefined;
  const leadWhere = and(ownerCond, projCond, gte(leads.createdAt, from));
  const bookingWhere = and(projectId ? eq(bookings.projectId, projectId) : undefined, gte(bookings.bookingDate, from));
  const paymentWhere = gte(payments.paymentDate, from);

  const [leadRows, bookingRows, paymentRows] = await Promise.all([
    leadWhere ? db.select({ createdAt: leads.createdAt }).from(leads).where(leadWhere) : Promise.resolve([] as { createdAt: Date }[]),
    bookingWhere ? db.select({ bookingDate: bookings.bookingDate, saleValue: bookings.saleValue, status: bookings.status }).from(bookings).where(bookingWhere) : Promise.resolve([] as { bookingDate: Date; saleValue: string; status: string }[]),
    db.select({ paymentDate: payments.paymentDate, amount: payments.amount }).from(payments).where(paymentWhere),
  ]);

  const monthsArray: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(from);
    d.setUTCMonth(from.getUTCMonth() + i, 1);
    monthsArray.push(monthKey(d));
  }
  const blank = () => ({ month: '', leads: 0, bookings: 0, saleValue: 0, collected: 0 });
  const buckets: Record<string, ReturnType<typeof blank>> = {};
  for (const m of monthsArray) buckets[m] = { ...blank(), month: m };

  for (const r of leadRows) {
    const b = buckets[monthKey(r.createdAt)];
    if (b) b.leads += 1;
  }
  for (const r of bookingRows) {
    const b = buckets[monthKey(r.bookingDate)];
    if (b) {
      b.bookings++;
      if (r.status !== 'CANCELLED') b.saleValue += num(r.saleValue);
    }
  }
  for (const r of paymentRows) {
    const b = buckets[monthKey(r.paymentDate)];
    if (b) b.collected += num(r.amount);
  }
  return monthsArray.map((m) => {
    const b = buckets[m];
    return { month: m, leads: b.leads, bookings: b.bookings, saleValue: Math.round(b.saleValue), collected: Math.round(b.collected) };
  });
}

export interface DashboardFilters {
  projectId?: string;
  from?: string;
  to?: string;
}

/** Summary dashboard KPIs. */
export async function getDashboard(actor: Actor, filters: DashboardFilters = {}) {
  const ownerIds = await resolveVisibleUserIds(actor.user);
  const ownerCond = ownerIds ? inArray(leads.ownerId, ownerIds) : undefined;
  const leadWhere = and(ownerCond, filters.projectId ? eq(leads.projectId, filters.projectId) : undefined);
  const bookingWhere = filters.projectId ? eq(bookings.projectId, filters.projectId) : undefined;

  const [
    leadState,
    bookingRows,
    paymentRows,
    customerCount,
    overdue,
    visitRows,
    commissionRows,
    teamCount,
  ] = await Promise.all([
    db.select({ status: leads.status, count: sql<number>`count(*)::int` }).from(leads).where(leadWhere ?? sql`true`).groupBy(leads.status),
    bookingRows0(bookingWhere),
    paymentRows0(),
    db.select({ count: sql<number>`count(*)::int` }).from(customers).where(sql`true`),
    db.select({ count: sql<number>`count(*)::int` }).from(leads).where(and(leadWhere, sql`${leads.status} = 'FOLLOW_UP' AND ${leads.updatedAt} < now() - interval '3 days'`)),
    visits0(ownerIds),
    commissionRows0(),
    db.select({ count: sql<number>`count(*)::int` }).from(users).where(eq(users.role, 'SALES_EXECUTIVE')),
  ]);

  const leadCount = leadState.reduce((s, r) => s + r.count, 0);
  const bookingData = bookingRows.map((b) => ({ ...b, saleValue: num(b.saleValue), bookingAmount: num(b.bookingAmount) }));
  const saleValue = bookingData.filter((b) => b.status !== 'CANCELLED').reduce((s, b) => s + b.saleValue, 0);
  const bookingsCount = bookingData.length;
  const collected = paymentRows.reduce((s, p) => s + num(p.amount), 0);

  return {
    leads: {
      total: leadCount,
      new: leadState.find((r) => r.status === 'NEW')?.count ?? 0,
      followUp: leadState.find((r) => r.status === 'FOLLOW_UP')?.count ?? 0,
      meeting: (leadState.find((r) => r.status === 'NEGOTIATION')?.count ?? 0) + (leadState.find((r) => r.status === 'BOOKING')?.count ?? 0),
      overdueFollowups: overdue[0]?.count ?? 0,
    },
    bookings: { total: bookingsCount, saleValue: Math.round(saleValue), newThisMonth: 0 },
    collections: Math.round(collected),
    customers: customerCount[0]?.count ?? 0,
    visits: { scheduled: visitRows.find((v) => v.status === 'SCHEDULED')?.count ?? 0, completed: visitRows.find((v) => v.status === 'COMPLETED')?.count ?? 0, total: visitRows.reduce((s, v) => s + v.count, 0) },
    commissions: { entitlements: commissionRows.reduce((s, c) => s + num(c.amount), 0) },
    conversion: leadCount ? Math.round((bookingsCount / leadCount) * 1000) / 10 : 0,
    trend: await getTrendSeries(actor, 6, filters.projectId),
  };
}

async function bookingRows0(where: any) {
  return db.select({ bookingDate: bookings.bookingDate, saleValue: bookings.saleValue, bookingAmount: bookings.bookingAmount, status: bookings.status }).from(bookings).where(where ?? sql`true`);
}
async function paymentRows0() {
  return db.select({ amount: payments.amount, status: payments.status, paymentDate: payments.paymentDate }).from(payments);
}
async function visits0(ownerIds: string[] | null) {
  const conds: any[] = [];
  if (ownerIds) conds.push(inArray(meetings.assignedTo, ownerIds));
  return db.select({ status: meetings.status, count: sql<number>`count(*)::int` }).from(meetings).where(conds.length ? and(...conds) : sql`true`).groupBy(meetings.status);
}
async function commissionRows0() {
  return db.select({ amount: commissionSnapshots.amount }).from(commissionSnapshots).where(eq(commissionSnapshots.status, 'PAYABLE'));
}

/** Sales reports (per-user, per-project, per-status). */
export async function getSalesReport(actor: Actor, filters: DashboardFilters = {}) {
  const ownerIds = await resolveVisibleUserIds(actor.user);
  const where = await bookingScope(actor, filters);

  const [byUser, byProject, byStatus, bySource, cancelled, scoped] = await Promise.all([
    db
      .select({ userId: bookings.salespersonId, name: users.name, count: sql<number>`count(*)::int`, value: sql<string>`coalesce(sum(${bookings.saleValue}), 0)::text` })
      .from(bookings)
      .leftJoin(users, eq(bookings.salespersonId, users.id))
      .where(where)
      .groupBy(bookings.salespersonId, users.name),
    db
      .select({ projectId: bookings.projectId, name: projects.name, count: sql<number>`count(*)::int`, value: sql<string>`coalesce(sum(${bookings.saleValue}), 0)::text` })
      .from(bookings)
      .leftJoin(projects, eq(bookings.projectId, projects.id))
      .where(where)
      .groupBy(bookings.projectId, projects.name),
    db
      .select({ status: bookings.status, count: sql<number>`count(*)::int`, value: sql<string>`coalesce(sum(${bookings.saleValue}), 0)::text` })
      .from(bookings)
      .where(where)
      .groupBy(bookings.status),
    // Lead-source mix counts LEADS (not bookings), keyed on when the lead was
    // created, so it will not sum to summary.count. It is still scoped to the
    // same owner/project/date bounds as the rest of the report: an unscoped
    // org-wide count here would leak funnel volume to restricted roles and
    // contradict every other block on the page.
    db
      .select({ source: leads.source, count: sql<number>`count(*)::int` })
      .from(leads)
      .where(leadScope(ownerIds, filters))
      .groupBy(leads.source),
    db
      .select({ projectId: bookings.projectId, count: sql<number>`count(*)::int`, rate: sql<number>`(count(*) FILTER (WHERE ${bookings.status} = 'CANCELLED'))::int` })
      .from(bookings)
      .where(where)
      .groupBy(bookings.projectId),
    db.select({ saleValue: bookings.saleValue, status: bookings.status }).from(bookings).where(where),
  ]);

  const cancelledCount = scoped.filter((r) => r.status === 'CANCELLED').length;

  return {
    summary: {
      count: scoped.length,
      value: Math.round(scoped.filter((r) => r.status !== 'CANCELLED').reduce((s, r) => s + num(r.saleValue), 0)),
      cancelled: cancelledCount,
      cancellationRate: scoped.length ? Math.round((cancelledCount / scoped.length) * 1000) / 10 : 0,
      range: { from: filters.from ?? null, to: filters.to ?? null },
    },
    byUser,
    byProject,
    byStatus,
    bySource,
    cancellationMatrix: cancelled,
  };
}

/** Visibility + project + date bounds for lead-based breakdowns (createdAt). */
function leadScope(ownerIds: string[] | null, filters: DashboardFilters) {
  return and(
    ownerIds ? inArray(leads.ownerId, ownerIds) : undefined,
    filters.projectId ? eq(leads.projectId, filters.projectId) : undefined,
    rangeCond(leads.createdAt, filters),
  );
}

/**
 * Single source of truth for who/what the sales report may show: the actor's
 * visible salespeople, the requested project, and an inclusive date range.
 * A report must never widen past these bounds.
 */
async function bookingScope(actor: Actor, filters: DashboardFilters) {
  const ownerIds = await resolveVisibleUserIds(actor.user);
  return and(
    ownerIds ? inArray(bookings.salespersonId, ownerIds) : undefined,
    filters.projectId ? eq(bookings.projectId, filters.projectId) : undefined,
    rangeCond(bookings.bookingDate, filters),
  );
}

/**
 * Cancellation analysis.
 *
 * Previously this only filtered on projectId, so a restricted role saw
 * org-wide refund totals. It is now bounded three ways: the salesperson the
 * booking belonged to must be visible to the actor, the project must match,
 * and the window applies to `cancelledAt` (when the cancellation happened),
 * which is the natural reading of a date range on a cancellation report.
 * Cancellations whose booking is missing drop out for restricted roles
 * because there is no owner to attribute them to.
 */
export async function getCancellationReport(actor: Actor, filters: DashboardFilters = {}) {
  const ownerIds = await resolveVisibleUserIds(actor.user);
  const where = and(
    ownerIds ? inArray(bookings.salespersonId, ownerIds) : undefined,
    filters.projectId ? eq(bookings.projectId, filters.projectId) : undefined,
    rangeCond(cancellations.cancelledAt, filters),
  );
  const rows = await db
    .select({ reasonCategory: cancellations.reasonCategory, status: cancellations.approvalStatus, count: sql<number>`count(*)::int`, amount: sql<string>`coalesce(sum(${cancellations.refundAmount}), 0)::text` })
    .from(cancellations)
    .leftJoin(bookings, eq(cancellations.bookingId, bookings.id))
    .where(where ?? sql`true`)
    .groupBy(cancellations.reasonCategory, cancellations.approvalStatus);
  const total = rows.reduce((s, r) => s + r.count, 0);
  return {
    total,
    totalRefund: Math.round(rows.reduce((s, r) => s + num(r.amount), 0)),
    byCategory: rows,
    scope: { from: filters.from ?? null, to: filters.to ?? null, restricted: ownerIds !== null },
  };
}