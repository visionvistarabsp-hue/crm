import { db } from '../db';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { Actor } from '../api';
import { ApiError } from '../api';
import type { PayoutBatch } from '../db/schema';
import { payoutBatches, payoutTransactions, commissionSnapshots, users } from '../db/schema';
import { nextNumber } from './counters';
import { payoutCreateSchema } from '../validators';
import { writeAudit } from '../audit';

const num = (v: number | string | null | undefined): number => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return isNaN(Number(n)) ? 0 : Number(n);
};

/** Select payable commissions (PAYABLE/APPROVED, not already in a batch). */
async function collectPayableSnapshots(opts: { snapshotIds?: string[]; periodFrom?: Date; periodTo?: Date }) {
  const conds: any[] = [inArray(commissionSnapshots.status, ['PAYABLE', 'APPROVED'])];
  const inBatch = await db.select({ snapshotId: payoutTransactions.snapshotId }).from(payoutTransactions).where(sql`${payoutTransactions.snapshotId} IS NOT NULL`);
  const inSet = new Set(inBatch.map((r) => r.snapshotId));
  if (opts.snapshotIds?.length) {
    conds.push(inArray(commissionSnapshots.id, opts.snapshotIds));
  }
  if (opts.periodFrom) conds.push(sql`${commissionSnapshots.payableOn} >= ${opts.periodFrom}`);
  if (opts.periodTo) conds.push(sql`${commissionSnapshots.payableOn} <= ${opts.periodTo}`);
  const snaps = await db.query.commissionSnapshots.findMany({ where: and(...conds) });
  return snaps.filter((s) => !inSet.has(s.id));
}

export async function listPayoutBatches() {
  const rows = await db.query.payoutBatches.findMany({
    orderBy: [desc(payoutBatches.createdAt)],
    with: { },
  });
  const withTotals = await Promise.all(
    rows.map(async (b) => {
      const txs = await db.query.payoutTransactions.findMany({ where: eq(payoutTransactions.batchId, b.id) });
      return {
        ...b,
        transactionCount: txs.length,
        totalAmount: txs.reduce((s, t) => s + num(t.amount), 0),
      };
    }),
  );
  return withTotals;
}

export async function createPayoutBatch(actor: Actor, rawData: unknown): Promise<PayoutBatch> {
  const data = payoutCreateSchema.parse(rawData);
  const snaps = await collectPayableSnapshots({
    snapshotIds: data.snapshotIds,
    periodFrom: data.periodFrom instanceof Date ? data.periodFrom : data.periodFrom ? new Date(data.periodFrom) : undefined,
    periodTo: data.periodTo instanceof Date ? data.periodTo : data.periodTo ? new Date(data.periodTo) : undefined,
  });
  if (!snaps.length) throw new ApiError(422, 'No payable commissions found for the batch');

  const batchNo = await nextNumber('payout', 'PO');
  const total = snaps.reduce((s, x) => s + num(x.amount), 0);

  const [batch] = await db
    .insert(payoutBatches)
    .values({
      batchNo,
      status: 'DRAFT',
      periodFrom: data.periodFrom instanceof Date ? data.periodFrom : data.periodFrom ? new Date(data.periodFrom) : null,
      periodTo: data.periodTo instanceof Date ? data.periodTo : data.periodTo ? new Date(data.periodTo) : null,
      totalAmount: total.toFixed(2),
      createdById: actor.user.id,
    })
    .returning();

  await db.insert(payoutTransactions).values(
    snaps.map((s) => ({
      batchId: batch.id,
      snapshotId: s.id,
      personId: s.personId,
      amount: s.amount,
      status: 'PENDING',
      createdById: actor.user.id,
    })),
  );
  await writeAudit({ actor, action: 'PAYOUT', entity: 'payout-batch', entityId: batch.id, newValue: { batchNo, count: snaps.length, total } });
  return batch;
}

async function getBatchWithTxs(batchId: string) {
  const batch = await db.query.payoutBatches.findFirst({ where: eq(payoutBatches.id, batchId) });
  if (!batch) throw new ApiError(404, 'Payout batch not found');
  const txs = await db.query.payoutTransactions.findMany({ where: eq(payoutTransactions.batchId, batchId) });
  return { batch, txs };
}

/** Process a draft batch: mark transactions processed and snapshots paid. */
export async function processPayoutBatch(actor: Actor, batchId: string): Promise<PayoutBatch> {
  const { batch, txs } = await getBatchWithTxs(batchId);
  if (batch.status !== 'DRAFT') throw new ApiError(422, `Batch is ${batch.status}`);

  await db.transaction(async (tx) => {
    for (const t of txs) {
      if (t.snapshotId) {
        await tx.update(commissionSnapshots).set({ status: 'PAID', updatedAt: new Date() }).where(eq(commissionSnapshots.id, t.snapshotId));
      }
      await tx.update(payoutTransactions).set({ status: 'PROCESSED' }).where(eq(payoutTransactions.id, t.id));
    }
    await tx.update(payoutBatches).set({ status: 'PROCESSED', processedAt: new Date(), approvedById: actor.user.id, updatedAt: new Date() }).where(eq(payoutBatches.id, batchId));
  });

  await writeAudit({ actor, action: 'PAYOUT', entity: 'payout-batch', entityId: batchId, newValue: { status: 'PROCESSED' } });
  return (await db.query.payoutBatches.findFirst({ where: eq(payoutBatches.id, batchId) }))!;
}

/** Mark a processed batch as PAID (actual money out). */
export async function finalizePayoutBatch(actor: Actor, batchId: string): Promise<PayoutBatch> {
  const { batch, txs } = await getBatchWithTxs(batchId);
  if (batch.status !== 'PROCESSED') throw new ApiError(422, `Batch is ${batch.status}`);
  await db.transaction(async (tx) => {
    for (const t of txs) {
      await tx.update(payoutTransactions).set({ status: 'PAID', paidAt: new Date() }).where(eq(payoutTransactions.id, t.id));
    }
    await tx.update(payoutBatches).set({ status: 'PAID', updatedAt: new Date() }).where(eq(payoutBatches.id, batchId));
  });
  await writeAudit({ actor, action: 'PAYOUT', entity: 'payout-batch', entityId: batchId, newValue: { status: 'PAID' } });
  return (await db.query.payoutBatches.findFirst({ where: eq(payoutBatches.id, batchId) }))!;
}

export async function reversePayoutTx(actor: Actor, txId: string): Promise<void> {
  const t = await db.query.payoutTransactions.findFirst({ where: eq(payoutTransactions.id, txId) });
  if (!t) throw new ApiError(404, 'Payout not found');
  await db.transaction(async (tx) => {
    await tx.update(payoutTransactions).set({ status: 'REVERSED' }).where(eq(payoutTransactions.id, txId));
    if (t.snapshotId) {
      await tx.update(commissionSnapshots).set({ status: 'PAYABLE', updatedAt: new Date() }).where(eq(commissionSnapshots.id, t.snapshotId));
    }
  });
  await writeAudit({ actor, action: 'PAYOUT', entity: 'payout-transaction', entityId: txId, newValue: { status: 'REVERSED' } });
}

export async function getPayoutDashboard() {
  const [commissions, batches, txs, staff] = await Promise.all([
    db.query.commissionSnapshots.findMany({}),
    db.query.payoutBatches.findMany({}),
    db.query.payoutTransactions.findMany({}),
    db.query.users.findMany({ where: inArray(users.role, ['SALES_EXECUTIVE', 'TEAM_LEADER', 'SALES_MANAGER']) }),
  ]);
  const g = (st: string) => txs.filter((x) => x.status === st).reduce((s, x) => s + num(x.amount), 0);
  const byPerson = staff.map((u) => ({
    id: u.id,
    name: u.name,
    payable: commissions.filter((c) => c.personId === u.id && ['PAYABLE', 'APPROVED'].includes(c.status)).reduce((s, c) => s + num(c.amount), 0),
    paid: txs.filter((t) => t.personId === u.id && t.status === 'PAID').reduce((s, t) => s + num(t.amount), 0),
  }));

  return {
    batchesCount: batches.length,
    drafts: batches.filter((b) => b.status === 'DRAFT').length,
    pending: g('PENDING'),
    processed: g('PROCESSED'),
    paid: g('PAID'),
    byPerson: byPerson.filter((p) => p.payable > 0 || p.paid > 0),
  };
}