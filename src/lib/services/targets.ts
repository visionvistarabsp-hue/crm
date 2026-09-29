/**
 * Sales targets: setting them, and reporting achievement against them.
 *
 * Achievement is computed from the same booking/payment rows the rest of the
 * app already treats as truth, so a target can never disagree with the
 * bookings list.
 */
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { ApiError, type Actor, resolveVisibleUserIds } from '@/lib/api';
import { writeAudit } from '@/lib/audit';
import { db } from '@/lib/db';
import { bookings, leadActivities, leads, payments, salesTargets, users } from '@/lib/db/schema';
import { NOT_HIDDEN_DRAFT } from './easy';
import { assertAssignableTarget } from './users';
import {
  achievement,
  computeForecast,
  focusQueue,
  isPeriod,
  num,
  periodRange,
  round2,
  weighLead,
  type Achievement,
  type FocusLead,
  type ForecastResult,
} from './forecast';

export interface TargetRow {
  userId: string;
  projectId?: string | null;
  bookingValueTarget?: string | number | null;
  collectionTarget?: string | number | null;
  leadCountTarget?: number | null;
  bookingCountTarget?: number | null;
}

export interface TargetAchievementRow {
  userId: string;
  name: string;
  role: string;
  bookingValue: Achievement;
  collection: Achievement;
  leadCount: Achievement;
  bookingCount: Achievement;
  forecastValue: number;
}

/**
 * Upsert one person's target for a period.
 *
 * Postgres treats NULLs as distinct in a unique index, so the "all projects"
 * row cannot rely on the composite unique constraint - hence the explicit
 * existence check plus update.
 */
export async function setTarget(
  actor: Actor,
  period: string,
  row: TargetRow,
): Promise<void> {
  if (!isPeriod(period)) throw new ApiError(400, 'period must be YYYY-MM', 'VALIDATION');

  // The target holder must be a real, active person on the sales team.
  const holder = await assertAssignableTarget(actor.user, row.userId);
  // Numeric columns are strings in this schema, so normalise before writing
  // rather than letting Postgres reject a JS number.
  const values = {
    userId: holder.id,
    projectId: row.projectId ?? null,
    bookingValueTarget: row.bookingValueTarget != null ? String(row.bookingValueTarget) : null,
    collectionTarget: row.collectionTarget != null ? String(row.collectionTarget) : null,
    leadCountTarget: row.leadCountTarget ?? null,
    bookingCountTarget: row.bookingCountTarget ?? null,
    updatedAt: new Date(),
    setById: actor.user.id,
  };

  const existing = await db
    .select({ id: salesTargets.id })
    .from(salesTargets)
    .where(
      and(
        eq(salesTargets.userId, row.userId),
        eq(salesTargets.period, period),
        row.projectId ? eq(salesTargets.projectId, row.projectId) : sql`${salesTargets.projectId} is null`,
      ),
    )
    .limit(1);

  if (existing[0]) {
    await db.update(salesTargets).set(values).where(eq(salesTargets.id, existing[0].id));
  } else {
    await db.insert(salesTargets).values({ ...values, period });
  }

  await writeAudit({
    actor,
    action: 'UPDATE',
    entity: 'sales_target',
    entityId: row.userId,
    newValue: { period, ...values },
    meta: { period },
  });
}

/** Bulk set, as the targets form submits one row per salesperson. */
export async function setTargetsBulk(
  actor: Actor,
  period: string,
  rows: TargetRow[],
): Promise<{ saved: number }> {
  if (!isPeriod(period)) throw new ApiError(400, 'period must be YYYY-MM', 'VALIDATION');
  for (const row of rows) await setTarget(actor, period, row);
  return { saved: rows.length };
}

interface ActualTotals {
  bookingValue: number;
  collection: number;
  leadCount: number;
  bookingCount: number;
}

/**
 * Realised numbers for a period.
 *
 * Bookings are counted by booking date and exclude cancellations - a cancelled
 * booking was never a sale. Collection is by payment date, so it lines up with
 * the cash actually received in that month.
 */
async function actualsFor(
  userIds: string[],
  period: string,
  projectId?: string,
): Promise<Map<string, ActualTotals>> {
  const out = new Map<string, ActualTotals>();
  if (userIds.length === 0) return out;
  const { from, to } = periodRange(period);

  const zero = (): ActualTotals => ({ bookingValue: 0, collection: 0, leadCount: 0, bookingCount: 0 });
  for (const id of userIds) out.set(id, zero());

  const bookingConds = [
    inArray(bookings.salespersonId, userIds),
    gte(bookings.bookingDate, from),
    lt(bookings.bookingDate, to),
    sql`${bookings.status} <> 'CANCELLED'`,
    // Hidden placeholder drafts are not bookings, so they must not inflate
    // bookingCount. Collections against them are still real and stay counted
    // below - only the booking side is filtered.
    NOT_HIDDEN_DRAFT,
    projectId ? eq(bookings.projectId, projectId) : undefined,
  ];
  const bookingRows = await db
    .select({
      id: bookings.id,
      userId: bookings.salespersonId,
      saleValue: bookings.saleValue,
    })
    .from(bookings)
    .where(and(...bookingConds));

  const payConds = [
    inArray(payments.bookingId, db.select({ id: bookings.id }).from(bookings)),
    gte(payments.paymentDate, from),
    lt(payments.paymentDate, to),
    eq(payments.status, 'RECEIVED'),
  ];
  const payRows = await db
    .select({ bookingId: payments.bookingId, amount: payments.amount })
    .from(payments)
    .where(and(...payConds));

  const bookingOwner = new Map(bookingRows.map((r) => [r.id, r.userId] as const));
  for (const r of bookingRows) {
    const t = r.userId ? out.get(r.userId) : undefined;
    if (t) {
      t.bookingCount += 1;
      t.bookingValue = round2(t.bookingValue + num(r.saleValue));
    }
  }
  for (const r of payRows) {
    const owner = bookingOwner.get(r.bookingId);
    const t = owner ? out.get(owner) : undefined;
    if (t) t.collection = round2(t.collection + num(r.amount));
  }

  // Leads created in the period, counted for the person who owns them now.
  const leadConds = [
    inArray(leads.ownerId, userIds),
    gte(leads.createdAt, from),
    lt(leads.createdAt, to),
    projectId ? eq(leads.projectId, projectId) : undefined,
  ];
  const leadRows = await db
    .select({ ownerId: leads.ownerId })
    .from(leads)
    .where(and(...leadConds));
  for (const r of leadRows) {
    const t = r.ownerId ? out.get(r.ownerId) : undefined;
    if (t) t.leadCount += 1;
  }

  return out;
}

export interface TargetReport {
  period: string;
  projectId: string | null;
  rows: TargetAchievementRow[];
  totals: {
    bookingValue: Achievement;
    collection: Achievement;
    leadCount: Achievement;
    bookingCount: Achievement;
  };
  forecast: ForecastResult;
  focus: FocusLead[];
}

/**
 * The report behind /targets: who is on target, and what the open pipeline is
 * actually worth. Scoped to the people the actor may see, so a team leader gets
 * their reports and an executive gets only themselves.
 */
export async function getTargetReport(
  actor: Actor,
  period: string,
  projectId?: string,
): Promise<TargetReport> {
  if (!isPeriod(period)) throw new ApiError(400, 'period must be YYYY-MM', 'VALIDATION');

  const visibleIds = await resolveVisibleUserIds(actor.user);
  const team = await db
    .select({ id: users.id, name: users.name, role: users.role })
    .from(users)
    .where(
      and(
        eq(users.isActive, true),
        visibleIds ? inArray(users.id, visibleIds) : undefined,
        // A target is a sales concept; no point listing document managers.
        inArray(users.role, ['SALES_EXECUTIVE', 'TEAM_LEADER', 'SALES_MANAGER', 'ADMIN', 'SUPER_ADMIN']),
      ),
    );

  const userIds = team.map((t) => t.id);
  const targetRows = await db
    .select()
    .from(salesTargets)
    .where(
      and(
        eq(salesTargets.period, period),
        inArray(salesTargets.userId, userIds.length ? userIds : ['-']),
        projectId ? eq(salesTargets.projectId, projectId) : sql`${salesTargets.projectId} is null`,
      ),
    );

  const targetByUser = new Map(targetRows.map((t) => [t.userId, t]));
  const actuals = await actualsFor(userIds, period, projectId);
  const openLeads = await openLeadsFor(userIds, projectId);

  // Expected value per person, then the team total from the same lead set.
  const expectedByUser = new Map<string, number>();
  for (const lead of openLeads) {
    const { expectedValue } = weighLead(lead, new Date());
    if (!lead.ownerId) continue;
    expectedByUser.set(lead.ownerId, round2((expectedByUser.get(lead.ownerId) ?? 0) + expectedValue));
  }
  const combined = computeForecast(openLeads as never);

  const rows: TargetAchievementRow[] = team
    .map((t) => {
      const target = targetByUser.get(t.id);
      const actual = actuals.get(t.id) ?? {
        bookingValue: 0, collection: 0, leadCount: 0, bookingCount: 0,
      };
      return {
        userId: t.id,
        name: t.name,
        role: t.role,
        bookingValue: achievement(target?.bookingValueTarget ?? null, actual.bookingValue),
        collection: achievement(target?.collectionTarget ?? null, actual.collection),
        leadCount: achievement(target?.leadCountTarget ?? null, actual.leadCount),
        bookingCount: achievement(target?.bookingCountTarget ?? null, actual.bookingCount),
        forecastValue: expectedByUser.get(t.id) ?? 0,
      };
    })
    .sort((a, b) => {
      // People who have a target first, then by attainment; unset-target
      // people sink so a manager is not comparing against blanks.
      const aSet = a.bookingValue.target !== null;
      const bSet = b.bookingValue.target !== null;
      if (aSet !== bSet) return aSet ? -1 : 1;
      return (b.bookingValue.attainment ?? 0) - (a.bookingValue.attainment ?? 0);
    });

  const sum = (pick: (r: TargetAchievementRow) => Achievement, key: 'target' | 'actual') =>
    round2(rows.reduce((s, r) => s + num(pick(r)[key]), 0));
  const totalTarget = <K extends 'target' | 'actual'>(pick: (r: TargetAchievementRow) => Achievement, key: K) => {
    const set = rows.filter((r) => pick(r).target !== null);
    if (set.length === 0) return { target: null, actual: 0, attainment: null, gap: 0, pct: 0 };
    return achievement(sum(pick, key), set.reduce((s, r) => s + num(pick(r).actual), 0));
  };

  return {
    period,
    projectId: projectId ?? null,
    rows,
    totals: {
      bookingValue: totalTarget((r) => r.bookingValue, 'target'),
      collection: totalTarget((r) => r.collection, 'target'),
      leadCount: totalTarget((r) => r.leadCount, 'target'),
      bookingCount: totalTarget((r) => r.bookingCount, 'target'),
    },
    forecast: combined,
    focus: focusQueue(combined.weightedLeads, 12),
  };
}

/**
 * Open, in-scope leads for the given people.
 *
 * `leadActivities` is the real signal for "last touch" - `leads.updatedAt` moves
 * on any unrelated write (a bulk tag edit, an assignment change), which would
 * make a cold lead look fresh.
 */
async function openLeadsFor(userIds: string[], projectId?: string) {
  if (userIds.length === 0) return [];
  const rows = await db
    .select({
      id: leads.id,
      name: leads.name,
      ownerId: leads.ownerId,
      status: leads.status,
      budget: leads.budget,
      createdAt: leads.createdAt,
    })
    .from(leads)
    .where(
      and(
        inArray(leads.ownerId, userIds),
        projectId ? eq(leads.projectId, projectId) : undefined,
      ),
    );

  if (rows.length === 0) return [];

  // One aggregate query for the newest activity per lead.
  const lastTouch = await db
    .select({
      leadId: leadActivities.leadId,
      at: sql<Date>`max(${leadActivities.createdAt})`,
    })
    .from(leadActivities)
    .where(inArray(leadActivities.leadId, rows.map((r) => r.id)))
    .groupBy(leadActivities.leadId);

  const touch = new Map(lastTouch.map((t) => [t.leadId, t.at] as const));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    ownerId: r.ownerId,
    status: r.status,
    budget: r.budget,
    createdAt: r.createdAt,
    lastActivityAt: touch.get(r.id) ?? null,
  }));
}
