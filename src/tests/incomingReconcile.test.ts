import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enqueueJobOnceDetailed } from '@/lib/queue';
import { INTEGRATION_SYNC_MAX_ATTEMPTS, syncRetryDigestKey } from '@/lib/services/incomingLeadSync';

/**
 * Regression cover for the reconciliation scan that closes the delivery gap:
 * a receipt that a webhook uplifted but the queue then could never apply (or
 * never picked up at all) must not sit in RECEIVED forever without a trace.
 *
 * The scan is the last line after the four queue attempts, so it must never
 * resurrect a receipt the queue proved unprocessable (FAILED -> terminal ERROR)
 * and must re-enqueue an orphan exactly once per tick (digest-deduped).
 */

const RECEIPT_ID = 'receipt-1';
const digestOf = (id: string) => `integration:${id}`;

type Update = { table: unknown; values: Record<string, unknown>; scope?: unknown; returning: boolean };
let updates: Update[];
let selectQueue: Array<{ table: unknown; rows: Array<Record<string, unknown>> }>;
let selectLog: unknown[];
let returningRows: Array<Record<string, unknown>>;
let enqueueOutcome: { status: 'queued' | 'duplicate' | 'failed'; id?: string; error?: unknown };

/** Pull the bound value out of a drizzle `eq(col, value)` condition. */
function paramOf(cond: unknown): unknown {
  const chunks = (cond as { queryChunks?: unknown[] })?.queryChunks ?? [];
  for (const c of chunks) {
    const v = (c as { value?: unknown }).value;
    if (v !== undefined && typeof v !== 'object') return v;
  }
  return undefined;
}

vi.mock('@/lib/db', () => {
  const c = {
    select: () => {
      const q: Record<string, unknown> = {};
      let table: unknown = null;
      q.from = (t: unknown) => {
        table = t;
        return q;
      };
      q.where = (cond: unknown) => {
        (q as Record<string, unknown>).__scope = paramOf(cond);
        return q;
      };
      q.orderBy = () => q;
      q.limit = () => q;
      q.then = (resolve: (v: unknown) => unknown) => {
        const entry = selectQueue.shift() ?? { table, rows: [] };
        selectLog.push(entry.table);
        return resolve(entry.rows);
      };
      return q;
    },
    update: () => {
      let table: unknown = null;
      let values: Record<string, unknown> = {};
      const q: Record<string, unknown> = {};

      const finish = (resolve: (v: unknown) => unknown) => {
        updates.push({ table, values, returning: (q as Record<string, unknown>).__returning === true });
        return resolve((q as Record<string, unknown>).__returning === true ? returningRows : {});
      };

      q.set = (v: Record<string, unknown>) => {
        values = v;
        return q;
      };
      q.withTable = (t: unknown) => {
        table = t;
        return q;
      };
      q.where = (cond: unknown) => {
        (q as Record<string, unknown>).__scope = paramOf(cond);
        return q;
      };
      q.returning = () => {
        (q as Record<string, unknown>).__returning = true;
        return q;
      };
      q.then = finish;
      // resolvable so `await` on a plain update chain works
      return q;
    },
  };
  return { db: c };
});

vi.mock('@/lib/services/leads', () => ({
  createLead: vi.fn(async () => ({
    lead: { id: 'lead-1', leadNo: 'LD-0001' },
    duplicates: [],
    created: true,
  })),
}));

vi.mock('@/lib/queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/queue')>();
  return {
    ...actual,
    enqueueJobOnceDetailed: vi.fn(async () => ({ status: 'queued', id: 'job-1' })),
    registerJobHandler: vi.fn(),
  };
});

import {
  scanIncomingLeads,
  retryIncomingReceipt,
  RECONCILE_STALE_MS,
  RECONCILE_MAX_SCAN,
} from '@/lib/services/incomingLeadSync';

beforeEach(() => {
  vi.clearAllMocks();
  updates = [];
  selectQueue = [];
  selectLog = [];
  returningRows = [];
  enqueueOutcome = { status: 'queued', id: 'job-1' };
  vi.mocked(enqueueJobOnceDetailed).mockImplementation(async () => enqueueOutcome as never);
});

const STALE = new Date('2026-09-29T00:00:00Z');
const reference = (now = new Date('2026-09-29T09:00:00Z')) => now;

function receiptCard(overrides: Record<string, unknown> = {}) {
  return {
    id: RECEIPT_ID,
    provider: 'magicbricks',
    status: 'RECEIVED',
    receivedAt: STALE,
    rawPayload: { name: 'Riya Shah', phone: '9876543210', lead_id: 'ext_77' },
    ...overrides,
  };
}

function failJobCard(overrides: Record<string, unknown> = {}) {
  return { lastError: 'assignment pool exhausted', ...overrides };
}

describe('scanIncomingLeads', () => {
  it('is a no-op when nothing is stale', async () => {
    selectQueue = [{ table: 'incomingLeads', rows: [] }];

    const result = await scanIncomingLeads(new Date('2026-09-29T09:00:00Z'));

    expect(result).toEqual({
      scanned: 0,
      exhausted: 0,
      requeued: 0,
      alreadyRetrying: 0,
      enqueueFailed: 0,
    });
    expect(enqueueJobOnceDetailed).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('pushes a FAILED attempt to terminal ERROR with the job lastError, and stops retrying it', async () => {
    // First select: stale receipts. Second select: the FAILED job lookup.
    selectQueue = [
      { table: 'incomingLeads', rows: [{ ...receiptCard() }] },
      { table: 'backgroundJobs', rows: [{ ...failJobCard() }] },
    ];

    const result = await scanIncomingLeads(reference());

    expect(result).toEqual({
      scanned: 1,
      exhausted: 1,
      requeued: 0,
      alreadyRetrying: 0,
      enqueueFailed: 0,
    });
    // No re-enqueue for a receipt the queue already gave up on.
    expect(enqueueJobOnceDetailed).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
    expect(updates[0].values.status).toBe('ERROR');
    expect(updates[0].values.error).toBe('assignment pool exhausted');
  });

  it('falls back to a generic error when the FAILED job has no lastError', async () => {
    selectQueue = [
      { table: 'incomingLeads', rows: [{ ...receiptCard() }] },
      { table: 'backgroundJobs', rows: [{ ...failJobCard({ lastError: null }) }] },
    ];

    await scanIncomingLeads(reference());

    expect(updates[0].values.status).toBe('ERROR');
    expect(updates[0].values.error).toBe('sync failed after max attempts');
  });

  it('re-enqueues an orphaned receipt exactly once, digest-deduped', async () => {
    selectQueue = [
      { table: 'incomingLeads', rows: [{ ...receiptCard() }] },
      { table: 'backgroundJobs', rows: [] }, // no job row at all
    ];

    const result = await scanIncomingLeads(reference());

    expect(result.requeued).toBe(1);
    expect(enqueueJobOnceDetailed).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(enqueueJobOnceDetailed).mock.calls[0];
    expect(payload[0]).toBe('INTEGRATION_SYNC');
    expect(payload[1]).toEqual({ incomingId: RECEIPT_ID });
    expect(payload[2]).toMatchObject({ digestKey: digestOf(RECEIPT_ID), maxAttempts: INTEGRATION_SYNC_MAX_ATTEMPTS });
    // The receipt stays RECEIVED for the queue to process.
    expect(updates).toHaveLength(0);
  });

  it('counts a receipt whose retry is already in flight as alreadyRetrying', async () => {
    enqueueOutcome = { status: 'duplicate', id: 'existing-1' };
    selectQueue = [
      { table: 'incomingLeads', rows: [{ ...receiptCard() }] },
      { table: 'backgroundJobs', rows: [] },
    ];

    const result = await scanIncomingLeads(reference());

    expect(result).toEqual({
      scanned: 1,
      exhausted: 0,
      requeued: 0,
      alreadyRetrying: 1,
      enqueueFailed: 0,
    });
    // No tombstone, no update: an in-flight retry must be left alone.
    expect(updates).toHaveLength(0);
  });

  it('counts an enqueue failure as enqueueFailed and leaves the receipt RECEIVED', async () => {
    enqueueOutcome = { status: 'failed', error: new Error('insert failed') };
    selectQueue = [
      { table: 'incomingLeads', rows: [{ ...receiptCard() }] },
      { table: 'backgroundJobs', rows: [] },
    ];

    const result = await scanIncomingLeads(reference());

    expect(result.enqueueFailed).toBe(1);
    expect(updates).toHaveLength(0);
  });

  it('processes every stale receipt in one tick, even after an exhausted one', async () => {
    selectQueue = [
      {
        table: 'incomingLeads',
        rows: [
          { ...receiptCard({ id: 'r-exhausted' }) },
          { ...receiptCard({ id: 'r-orphan' }) },
        ],
      },
      { table: 'backgroundJobs', rows: [{ ...failJobCard() }] }, // job lookup for r-exhausted
      { table: 'backgroundJobs', rows: [] }, // job lookup for r-orphan
    ];

    const result = await scanIncomingLeads(reference());

    expect(result).toEqual({
      scanned: 2,
      exhausted: 1,
      requeued: 1,
      alreadyRetrying: 0,
      enqueueFailed: 0,
    });
    expect(enqueueJobOnceDetailed).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueJobOnceDetailed).mock.calls[0][1]).toEqual({ incomingId: 'r-orphan' });
  });

  it('caps the batch at RECONCILE_MAX_SCAN and exposes the staleness window', () => {
    expect(RECONCILE_MAX_SCAN).toBe(200);
    expect(RECONCILE_STALE_MS).toBe(30 * 60_000);
  });
});

describe('retryIncomingReceipt', () => {
  it('reports a missing receipt without touching anything', async () => {
    selectQueue = [{ table: 'incomingLeads', rows: [] }];

    const result = await retryIncomingReceipt(RECEIPT_ID);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('receipt not found');
    expect(enqueueJobOnceDetailed).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('is a no-op for a receipt that already resolved', async () => {
    selectQueue = [{ table: 'incomingLeads', rows: [{ ...receiptCard({ status: 'CREATED', leadId: 'lead-1' }) }] }];

    const result = await retryIncomingReceipt(RECEIPT_ID);

    expect(result).toMatchObject({ ok: true, retried: false, status: 'CREATED' });
    expect(enqueueJobOnceDetailed).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('revives the FAILED job instead of inserting a competing one', async () => {
    selectQueue = [{ table: 'incomingLeads', rows: [{ ...receiptCard() }] }];
    returningRows = [{ id: 'job-1' }];

    const result = await retryIncomingReceipt(RECEIPT_ID);

    expect(result).toMatchObject({ ok: true, retried: true, reused: true, status: 'RECEIVED' });
    // The receipt itself is untouched.
    expect(updates).toHaveLength(1);
    const jobUpdate = updates[0];
    expect(jobUpdate.values.status).toBe('PENDING');
    expect(jobUpdate.values.attempts).toBe(0);
    expect(jobUpdate.values.lastError).toBeNull();
    expect(jobUpdate.returning).toBe(true);
    expect(enqueueJobOnceDetailed).not.toHaveBeenCalled();
  });

  it('enqueues a fresh, digest-deduped job when no FAILED job exists', async () => {
    selectQueue = [{ table: 'incomingLeads', rows: [{ ...receiptCard() }] }];
    // The revive update matches nothing (empty returning), so the receipt falls
    // through to a fresh enqueue below.

    const result = await retryIncomingReceipt(RECEIPT_ID);

    expect(result).toMatchObject({ ok: true, retried: true, reused: false, status: 'RECEIVED' });
    expect(enqueueJobOnceDetailed).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(enqueueJobOnceDetailed).mock.calls[0];
    expect(payload[0]).toBe('INTEGRATION_SYNC');
    expect(payload[1]).toEqual({ incomingId: RECEIPT_ID });
    expect(payload[2]).toMatchObject({ digestKey: digestOf(RECEIPT_ID), maxAttempts: 4 });
  });

  it('reports when the retry is already queued', async () => {
    enqueueOutcome = { status: 'duplicate', id: 'job-9' };
    selectQueue = [{ table: 'incomingLeads', rows: [{ ...receiptCard() }] }];

    const result = await retryIncomingReceipt(RECEIPT_ID);

    expect(result).toMatchObject({ ok: true, retried: false, status: 'RECEIVED' });
  });

  it('surfaces an enqueue failure as ok:false', async () => {
    enqueueOutcome = { status: 'failed', error: new Error('digest conflict') };
    selectQueue = [{ table: 'incomingLeads', rows: [{ ...receiptCard() }] }];

    const result = await retryIncomingReceipt(RECEIPT_ID);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('digest conflict');
  });
});

describe('digest contract', () => {
  it('addresses the queue row the reconciliation scan looks up', () => {
    expect(syncRetryDigestKey(RECEIPT_ID)).toBe(digestOf(RECEIPT_ID));
    // The scan's FAILED lookup and the retry revive path both target this key,
    // so a receipt can never be re-enqueued behind a consumed FAILED row.
  });
});