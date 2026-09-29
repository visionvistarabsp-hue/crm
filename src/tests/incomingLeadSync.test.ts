import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enqueueJobOnceDetailed, registerJobHandler, integrationSyncBackoffMs } from '@/lib/queue';

/**
 * Regression cover for the INTEGRATION_SYNC worker and its retry policy.
 *
 * The webhook path enqueues one of these jobs when a synchronous lead creation
 * fails, and the queue retries it with a bounded exponential backoff. These
 * tests pin down the decisions that make the worker safe to run on a drain:
 *
 *  - a receipt that already reached a terminal status is a no-op (idempotent),
 *    so an overlapping drain cannot create a second lead;
 *  - a payload that fails validation is a *permanent* ERROR (no point retrying
 *    four times for a body that can never parse), while lead-creation failure
 *    surfaces as a throw so the queue retries;
 *  - the retry payload is deduped on a digest key tied to the receipt.
 */

const RECEIPT_ID = 'receipt-1';

type Update = { values: Record<string, unknown>; scope: unknown };
let updates: Update[];
let selectRows: Array<Record<string, unknown>>;

/** Pull the bound value out of a drizzle `eq(col, value)` condition. */
function paramOf(cond: unknown): unknown {
  const chunks = (cond as { queryChunks?: unknown[] })?.queryChunks ?? [];
  for (const c of chunks) {
    const v = (c as { value?: unknown }).value;
    if (v !== undefined && typeof v !== 'object') return v;
  }
  return undefined;
}

vi.mock('@/lib/db', () => ({
  db: {
    select: () => {
      const c: Record<string, unknown> = {};
      c.from = () => c;
      c.where = (cond: unknown) => {
        selectScope = paramOf(cond);
        return c;
      };
      c.limit = () => c;
      c.then = (resolve: (v: unknown) => unknown) => resolve(selectRows);
      return c;
    },
    update: () => {
      let values: Record<string, unknown> = {};
      let scope: unknown = Symbol('UNSCOPED');
      const c: Record<string, unknown> = {};
      c.set = (v: Record<string, unknown>) => {
        values = v;
        return c;
      };
      c.where = (cond: unknown) => {
        scope = paramOf(cond);
        return c;
      };
      c.then = (resolve: (v: unknown) => unknown) => {
        updates.push({ values, scope });
        return resolve({});
      };
      return c;
    },
  },
}));

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

import { createLead } from '@/lib/services/leads';
import {
  handleIntegrationSync,
  registerIntegrationSyncHandler,
  syncRetryDigestKey,
  INTEGRATION_SYNC_MAX_ATTEMPTS,
} from '@/lib/services/incomingLeadSync';

let selectScope: unknown;

beforeEach(() => {
  vi.clearAllMocks();
  updates = [];
  selectRows = [];
  selectScope = undefined;
});

describe('handleIntegrationSync', () => {
  const receipt = {
    id: RECEIPT_ID,
    provider: 'magicbricks',
    status: 'RECEIVED',
    receivedAt: new Date('2026-09-29T09:00:00Z'),
    rawPayload: { name: 'Riya Shah', phone: '9876543210', lead_id: 'ext_77' },
  };

  it('syncs a RECEIVED receipt to CREATED via the shared verdict step', async () => {
    selectRows = [{ ...receipt }];

    await handleIntegrationSync({ incomingId: RECEIPT_ID });

    expect(selectScope).toBe(RECEIPT_ID);
    expect(createLead).toHaveBeenCalledTimes(1);
    // The worker re-applies the provider `lead_id` alias before validating,
    // exactly like the webhook path, so the dedup key survives a retry.
    const args = vi.mocked(createLead).mock.calls[0];
    expect((args[1] as Record<string, unknown>).sourceRef).toBe('ext_77');
    // Attribution comes from the persisted actor, which the webhook path stores.
    expect((args[0] as { user: { id: string } }).user.id).toBe('system');

    expect(updates).toHaveLength(1);
    expect(updates[0].scope).toBe(RECEIPT_ID);
    expect(updates[0].values.status).toBe('CREATED');
  });

  it('uses the persisted actor of the original delivery for attribution', async () => {
    selectRows = [{ ...receipt }];

    await handleIntegrationSync({
      incomingId: RECEIPT_ID,
      actor: { id: 'user-7', name: 'Ritu', email: 'ritu@x.io', role: 'SALES_EXECUTIVE' },
    });

    const args = vi.mocked(createLead).mock.calls[0];
    expect((args[0] as { user: { id: string } }).user.id).toBe('user-7');
  });

  it('is a no-op for a receipt that already reached a terminal status', async () => {
    selectRows = [{ ...receipt, status: 'CREATED' }];

    await handleIntegrationSync({ incomingId: RECEIPT_ID });

    // A replayed or overlapping job must not create a second lead.
    expect(createLead).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('is a no-op when the receipt vanishes or the id is missing', async () => {
    await handleIntegrationSync({ incomingId: RECEIPT_ID }); // no rows
    expect(createLead).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);

    await handleIntegrationSync({}); // no incomingId at all
    expect(createLead).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('marks an unparsable payload ERROR permanently, without a retry', async () => {
    selectRows = [{ ...receipt, rawPayload: { phone: '123' } }]; // missing name

    await expect(handleIntegrationSync({ incomingId: RECEIPT_ID })).resolves.toBeUndefined();

    // A body that can never validate is terminal: no point retrying it.
    expect(createLead).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
    expect(updates[0].values.status).toBe('ERROR');
    expect(updates[0].scope).toBe(RECEIPT_ID);
  });

  it('rethrows a lead-creation failure so the queue retries with backoff', async () => {
    selectRows = [{ ...receipt }];
    vi.mocked(createLead).mockRejectedValueOnce(new Error('assignment pool exhausted'));

    await expect(handleIntegrationSync({ incomingId: RECEIPT_ID })).rejects.toThrow(
      'assignment pool exhausted',
    );

    // No status write: the receipt stays RECEIVED for the next attempt or for a
    // later reconciliation scan.
    expect(updates).toHaveLength(0);
  });
});

describe('retry policy', () => {
  it('dedups retries on a digest key tied to the receipt', () => {
    expect(syncRetryDigestKey(RECEIPT_ID)).toBe(`integration:${RECEIPT_ID}`);
  });

  it('allows four attempts before giving up', () => {
    expect(INTEGRATION_SYNC_MAX_ATTEMPTS).toBe(4);
  });

  it('grows the backoff exponentially and caps it at 15 minutes', () => {
    // attempts 1..4 get 30s, 60s, 120s, 240s; the cap holds it at 15m after.
    expect(integrationSyncBackoffMs(1)).toBe(30_000);
    expect(integrationSyncBackoffMs(2)).toBe(60_000);
    expect(integrationSyncBackoffMs(3)).toBe(120_000);
    expect(integrationSyncBackoffMs(4)).toBe(240_000);
    expect(integrationSyncBackoffMs(7)).toBe(15 * 60_000);
    expect(integrationSyncBackoffMs(99)).toBe(15 * 60_000);
  });
});

describe('registerIntegrationSyncHandler', () => {
  it('registers the INTEGRATION_SYNC handler', () => {
    registerIntegrationSyncHandler();
    expect(registerJobHandler).toHaveBeenCalledWith('INTEGRATION_SYNC', expect.any(Function));
  });
});