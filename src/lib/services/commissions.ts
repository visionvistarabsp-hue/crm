import { db } from '../db';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Actor } from '../api';
import { ApiError } from '../api';
import type { Booking, CommissionRule, CommissionSnapshot } from '../db/schema';
import { commissionRules, commissionSnapshots, commissionLedger, commissionAdjustments, users, payments } from '../db/schema';
import { commissionRuleCreateSchema, commissionRuleUpdateSchema } from '../validators';
import { writeAudit } from '../audit';
import type { DbLike } from './counters';

// ------------------------------------------------------------------
// Pure commission mathematical functions (unit-tested)
// ------------------------------------------------------------------
export interface CommissionRuleParams {
  type: string;
  rate?: number | string | null;
  fixedAmount?: number | string | null;
  slabConfig?: Array<{ max: number; rate: number; fixed?: number }> | null;
  collectionWindowDays?: number | null;
}

export interface CommissionBase {
  saleValue: number;
  collected: number;
}

export interface CommissionResult {
  amount: number;
  basis: 'SALE_VALUE' | 'COLLECTION';
  baseAmount: number;
}

const num = (v: number | string | null | undefined): number => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return isNaN(Number(n)) ? 0 : Number(n);
};

/** SLAB_BASED: piece-wise bracket commission on the sale value. */
export function slabCommission(slabs: Array<{ max: number; rate: number; fixed?: number }>, baseAmount: number): number {
  if (!slabs.length) return 0;
  const sorted = [...slabs].sort((a, b) => a.max - b.max);
  if (sorted[0].max < 0) return 0;
  let total = 0;
  let prev = 0;
  for (const slab of sorted) {
    if (baseAmount <= prev) break;
    const bucket = Math.min(baseAmount, slab.max) - prev;
    total += slab.fixed !== undefined && slab.fixed > 0 ? slab.fixed : bucket * (slab.rate / 100);
    prev = slab.max;
  }
  // overflow beyond the last slab uses the final slab rate
  if (baseAmount > prev && sorted.length) {
    const last = sorted[sorted.length - 1];
    total += (baseAmount - prev) * (last.rate / 100);
  }
  return total;
}

export function calcCommission(rule: CommissionRuleParams, base: CommissionBase): CommissionResult {
  const saleValue = num(base.saleValue);
  const collected = num(base.collected);
  const rate = num(rule.rate);
  const fixed = num(rule.fixedAmount);

  switch (rule.type) {
    case 'FIXED':
      return { amount: fixed, basis: 'SALE_VALUE', baseAmount: saleValue };
    case 'COLLECTION_BASED':
      return { amount: (collected * rate) / 100, basis: 'COLLECTION', baseAmount: collected };
    case 'SALE_VALUE_BASED':
      return { amount: (saleValue * rate) / 100, basis: 'SALE_VALUE', baseAmount: saleValue };
    case 'SLAB_BASED':
      return { amount: slabCommission(rule.slabConfig ?? [], saleValue), basis: 'SALE_VALUE', baseAmount: saleValue };
    case 'PERCENTAGE':
    default:
      return { amount: (saleValue * rate) / 100, basis: 'SALE_VALUE', baseAmount: saleValue };
  }
}

// ------------------------------------------------------------------
// Rule management (with versioning)
// ------------------------------------------------------------------
export async function listCommissionRules(): Promise<CommissionRule[]> {
  return db.query.commissionRules.findMany({
    orderBy: [desc(commissionRules.createdAt)],
    with: { },
  });
}

export async function createCommissionRule(actor: Actor, rawData: unknown): Promise<CommissionRule> {
  const data = commissionRuleCreateSchema.parse(rawData);
  const [created] = await db
    .insert(commissionRules)
    .values({
      name: data.name,
      type: data.type,
      payableTo: data.payableTo,
      personId: data.personId ?? null,
      projectId: data.projectId ?? null,
      brokerName: data.brokerName ?? null,
      rate: data.rate != null ? String(data.rate) : null,
      fixedAmount: data.fixedAmount != null ? String(data.fixedAmount) : null,
      slabConfig: data.slabConfig,
      collectionWindowDays: data.collectionWindowDays ?? null,
      effectiveFrom: data.effectiveFrom instanceof Date ? data.effectiveFrom : data.effectiveFrom ? new Date(data.effectiveFrom) : new Date(),
      effectiveTo: null,
      version: 1,
      isActive: true,
      notes: data.notes ?? null,
      createdById: actor.user.id,
    })
    .returning();
  await writeAudit({ actor, action: 'CREATE', entity: 'commission-rule', entityId: created.id, newValue: data });
  return created;
}

/**
 * Editing a rule creates a NEW version and retires the old one.
 * Existing booking snapshots are immutable, so historical payouts never change.
 */
export async function updateCommissionRule(actor: Actor, id: string, rawData: unknown): Promise<CommissionRule> {
  const data = commissionRuleUpdateSchema.parse(rawData);
  const existing = await db.query.commissionRules.findFirst({ where: eq(commissionRules.id, id) });
  if (!existing) throw new ApiError(404, 'Commission rule not found');

  const now = new Date();
  const version = (existing.version ?? 1) + 1;
  const [updated] = await db
    .insert(commissionRules)
    .values({
      name: data.name ?? existing.name,
      type: data.type ?? existing.type,
      payableTo: data.payableTo ?? existing.payableTo,
      personId: data.personId !== undefined ? (data.personId ?? null) : existing.personId,
      projectId: data.projectId !== undefined ? (data.projectId ?? null) : existing.projectId,
      brokerName: data.brokerName !== undefined ? (data.brokerName ?? null) : existing.brokerName,
      rate: data.rate != null ? String(data.rate) : existing.rate,
      fixedAmount: data.fixedAmount != null ? String(data.fixedAmount) : existing.fixedAmount,
      slabConfig: data.slabConfig ?? existing.slabConfig,
      collectionWindowDays: data.collectionWindowDays !== undefined ? (data.collectionWindowDays ?? null) : existing.collectionWindowDays,
      effectiveFrom: now,
      effectiveTo: null,
      version,
      isActive: true,
      notes: data.notes ?? existing.notes,
      createdById: actor.user.id,
    })
    .returning();
  await db.update(commissionRules).set({ isActive: false, effectiveTo: now, updatedAt: now }).where(eq(commissionRules.id, id));
  await writeAudit({ actor, action: 'UPDATE', entity: 'commission-rule', entityId: updated.id, oldValue: existing, newValue: updated, meta: { priorVersion: version - 1 } });
  return updated;
}

export async function getApplicableRule(personId: string | null | undefined, payableTo: string, projectId: string | null): Promise<CommissionRule | null> {
  const conds: any[] = [eq(commissionRules.isActive, true), eq(commissionRules.payableTo, payableTo)];
  if (personId) conds.push(isNull(commissionRules.personId));
  const base = await db.query.commissionRules.findMany({ where: and(...conds), orderBy: [desc(commissionRules.effectiveFrom)] });

  const personRules = base.filter((r) => r.personId === personId);
  const projectMatch = personRules.find((r) => r.projectId === projectId) ?? personRules.find((r) => r.projectId === null);
  if (projectMatch) return projectMatch;

  const roleRules = base; // personId null
  const roleProject = roleRules.find((r) => r.projectId === projectId) ?? roleRules.find((r) => r.projectId === null);
  return roleProject ?? null;
}

export interface RecipientInput {
  personId?: string | null;
  role?: string | null;
  brokerName?: string | null;
}

/** Compute and persist commission snapshots + ledger credit for a booking. */
export async function createBookingCommissions(
  actorId: string,
  booking: Booking,
  client: DbLike = db,
): Promise<CommissionSnapshot[]> {
  const saleValue = num(booking.saleValue);
  const paymentsRows: Array<{ amount: string | null; status: string }> = await client.select({ amount: payments.amount, status: payments.status }).from(payments).where(eq(payments.bookingId, booking.id));
  const collected = num(booking.bookingAmount) + paymentsRows.reduce((s, p) => s + (p.status === 'RECEIVED' ? num(p.amount) : 0), 0);

  const recipients: RecipientInput[] = [];
  if (booking.salespersonId) {
    const sp = await client.query.users.findFirst({ where: eq(users.id, booking.salespersonId) });
    recipients.push({ personId: booking.salespersonId, role: sp?.role });
  }
  if (booking.teamLeaderId) {
    recipients.push({ personId: booking.teamLeaderId, role: 'TEAM_LEADER' });
  }
  if (booking.brokerId) {
    recipients.push({ personId: booking.brokerId, role: 'BROKER' });
  } else if (booking.brokerName) {
    recipients.push({ personId: null, role: 'BROKER', brokerName: booking.brokerName });
  }

  const snapshots: CommissionSnapshot[] = [];
  for (const r of recipients) {
    const rule = await getApplicableRule(r.personId, r.role ?? 'SALES_EXECUTIVE', booking.projectId);
    if (!rule) continue;
    const result = calcCommission(rule, { saleValue, collected });
    const personName = r.personId
      ? (await client.query.users.findFirst({ where: eq(users.id, r.personId) }))?.name ?? null
      : r.brokerName ?? null;

    const [snap] = await client
      .insert(commissionSnapshots)
      .values({
        bookingId: booking.id,
        ruleId: rule.id,
        ruleVersion: rule.version,
        ruleName: rule.name,
        personId: r.personId ?? null,
        personRole: (r.role ?? 'SALES_EXECUTIVE'),
        personName,
        basis: result.basis,
        baseAmount: String(result.baseAmount),
        rate: rule.rate,
        amount: String(result.amount.toFixed(2)),
        status: 'PAYABLE',
        payableOn: booking.bookingDate,
        meta: { ruleType: rule.type },
      })
      .returning();
    snapshots.push(snap);

    await writeLedgerEntry(client, {
      personId: r.personId ?? null,
      snapshotId: snap.id,
      bookingId: booking.id,
      credit: result.amount,
      sourceType: 'COMMISSION',
      notes: `Commission ${rule.name} (v${rule.version}) on ${booking.bookingNo}`,
      actorId: actorId,
    });
  }
  return snapshots;
}

async function writeLedgerEntry(
  client: DbLike,
  input: {
    personId: string | null;
    snapshotId: string | null;
    bookingId: string | null;
    credit?: number;
    debit?: number;
    sourceType: string;
    notes: string;
    actorId: string;
  },
): Promise<void> {
  const last =
    input.personId
      ? await (client.query as any).commissionLedger.findFirst({ where: eq(commissionLedger.personId, input.personId), orderBy: (t: any, { desc: d }: any) => [d(t.createdAt)] })
      : null;
  const credit = input.credit ?? 0;
  const debit = input.debit ?? 0;
  const balance = num(last?.runningBalance ?? 0) + credit - debit;
  await client.insert(commissionLedger).values({
    personId: input.personId,
    snapshotId: input.snapshotId,
    bookingId: input.bookingId,
    credit: credit.toFixed(2),
    debit: debit.toFixed(2),
    runningBalance: balance.toFixed(2),
    sourceType: input.sourceType,
    sourceId: input.snapshotId ?? undefined,
    notes: input.notes,
    createdById: input.actorId,
  });
}

/** Reverse all commission entitlements for a booking (cancellation voucher). */
export async function reverseBookingCommissions(
  actor: Actor,
  bookingId: string,
  reason: string,
  client: DbLike = db,
): Promise<number> {
  const snaps = await client.query.commissionSnapshots.findMany({
    where: eq(commissionSnapshots.bookingId, bookingId),
  });
  let reversed = 0;
  for (const s of snaps) {
    if (!['PENDING', 'PAYABLE', 'APPROVED', 'PAID'].includes(s.status)) continue;
    await client
      .update(commissionSnapshots)
      .set({ status: 'REVERSED', updatedAt: new Date() })
      .where(eq(commissionSnapshots.id, s.id));
    await client.insert(commissionAdjustments).values({
      snapshotId: s.id,
      amount: (-num(s.amount)).toFixed(2),
      type: 'REVERSAL',
      reason: `Booking cancelled: ${reason}`,
      status: 'APPROVED',
      approvedById: actor.user.id,
      approvedAt: new Date(),
      createdById: actor.user.id,
    });
    if (s.personId) {
      await writeLedgerEntry(client, {
        personId: s.personId,
        snapshotId: s.id,
        bookingId,
        debit: num(s.amount),
        sourceType: 'REVERSAL',
        notes: `Reversal for ${reason}`,
        actorId: actor.user.id,
      });
    }
    reversed += 1;
  }
  return reversed;
}

export async function getPersonCommissionSummary(personId: string) {
  const snaps = await db.query.commissionSnapshots.findMany({ where: eq(commissionSnapshots.personId, personId) });
  const total = snaps.reduce((s, x) => s + num(x.amount), 0);
  const byStatus = (st: string[]) => st.reduce((s, stt) => s + snaps.filter((x) => x.status === stt).reduce((ss, x) => ss + num(x.amount), 0), 0);
  return {
    total,
    pending: byStatus(['PENDING']),
    payable: byStatus(['PAYABLE']),
    approved: byStatus(['APPROVED']),
    paid: byStatus(['PAID']),
    reversed: byStatus(['REVERSED']),
    count: snaps.length,
  };
}

export async function getCommissionDashboard() {
  const snaps = await db.query.commissionSnapshots.findMany({});
  const total = snaps.reduce((s, x) => s + num(x.amount), 0);
  const g = (st: string) => snaps.filter((x) => x.status === st).reduce((s, x) => s + num(x.amount), 0);
  const balance = await db.query.commissionLedger.findMany({});

  return {
    grossCommission: Math.round(total * 100) / 100,
    pending: Math.round(g('PENDING') * 100) / 100,
    payable: Math.round(g('PAYABLE') * 100) / 100,
    approved: Math.round(g('APPROVED') * 100) / 100,
    paid: Math.round(g('PAID') * 100) / 100,
    reversed: Math.round(g('REVERSED') * 100) / 100,
    outstandingBalance: Math.round(balance.reduce((s, x) => s + num(x.runningBalance), 0) * 100) / 100,
    snapshotCount: snaps.length,
  };
}

const numV = (v: number | string | null | undefined): number => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return isNaN(Number(n)) ? 0 : Number(n);
};

export { numV as num, commissionSnapshots, commissionAdjustments, commissionLedger };