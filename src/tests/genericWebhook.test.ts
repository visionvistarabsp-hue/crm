import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression cover for the generic provider webhook receipt.
 *
 * The bug under test: the route inserted a receipt row but never kept its id,
 * then updated `incoming_leads` with no `.where(...)`. Any inbound row in the
 * table would inherit this delivery's status, lead id and error.
 *
 * So the load-bearing assertion is not "the status is right" but "every write is
 * scoped to the receipt this request created".
 */

const RECEIPT_ID = 'receipt-abc';

type Update = { values: Record<string, unknown>; scope: unknown };
let updates: Update[];
let inserted: Array<Record<string, unknown>>;
let createLeadResult: { lead: { id: string; leadNo: string }; duplicates: unknown[]; created: boolean };
let createLeadImpl: (() => Promise<unknown>) | null;
let createLeadArgs: Record<string, unknown> | null;

/** Pull the bound value out of a drizzle `eq(col, value)` condition. */
function paramOf(cond: unknown): unknown {
  const chunks = (cond as { queryChunks?: unknown[] })?.queryChunks ?? [];
  for (const c of chunks) {
    const v = (c as { value?: unknown }).value;
    if (v !== undefined && typeof v !== 'object') return v;
  }
  return undefined;
}

vi.mock('@/lib/handlers', () => {
  // Auth is not what this test is about. `respondWith` is kept because it holds
  // the real status-code rule: a handler returning `{ error, status }` must not
  // reach the caller as a 200.
  const respondWith = (body: unknown): [unknown, number] => {
    if (body === null || typeof body !== 'object') return [body, 200];
    const { status, ...rest } = body as { status?: unknown };
    if (typeof status === 'number' && 'error' in rest) return [rest, status];
    return [body, 200];
  };
  return {
    respondWith,
    withApi:
      (h: (actor: unknown, req: Request, ctx: unknown) => Promise<unknown>) =>
      async (req: Request) => {
        const out = await h({ id: 'actor-1' }, req, { params: Promise.resolve({}) });
        if (out === undefined) return { status: 200, body: { ok: true } };
        const [body, status] = respondWith(out);
        return { status, body };
      },
  };
});

vi.mock('@/lib/db', () => ({
  db: {
    insert: () => {
      const c: Record<string, unknown> = {};
      c.values = (v: Record<string, unknown>) => {
        inserted.push(v);
        return c;
      };
      c.returning = () => Promise.resolve([{ id: RECEIPT_ID, ...inserted[inserted.length - 1] }]);
      return c;
    },
    update: () => {
      let values: Record<string, unknown> = {};
      // Start as "no where clause was ever called" so a forgotten .where() is
      // recorded as a failure rather than silently passing.
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
      const settle = (resolve: (v: unknown) => unknown) => {
        updates.push({ values, scope });
        return resolve({});
      };
      c.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
        try {
          return settle(resolve);
        } catch (e) {
          return reject(e);
        }
      };
      // A drizzle builder is a thenable, so `.catch()` on it awaits the query
      // first. Mirror that, otherwise a `.catch(() => undefined)` in the route
      // would record no write at all.
      c.catch = (onRejected: (e: unknown) => unknown) => settle(() => onRejected(new Error('update failed')));
      return c;
    },
  },
}));

vi.mock('@/lib/services/leads', () => ({
  createLead: (_actor: unknown, data: Record<string, unknown>) => {
    createLeadArgs = data;
    if (createLeadImpl) return createLeadImpl();
    return Promise.resolve(createLeadResult);
  },
}));

// The route now retries a failed delivery through the queue instead of burning
// the receipt to ERROR. The real `enqueueJobOnceDetailed` would hit a real DB
// insert with `.onConflictDoNothing()` - which this file's db mock does not
// provide - so it must be mocked here and asserted on directly.
vi.mock('@/lib/queue', () => ({
  enqueueJobOnceDetailed: vi.fn(async () => ({ status: 'queued', id: 'job-1' })),
  registerJobHandler: vi.fn(),
}));

import { enqueueJobOnceDetailed } from '@/lib/queue';
import { POST } from '@/app/api/webhooks/leads/route';

function req(body: unknown): Request {
  return new Request('https://example.test/api/webhooks/leads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const validBody = {
  provider: 'magicbricks',
  name: 'Riya Shah',
  phone: '9876543210',
  email: 'riya@example.com',
  sourceRef: 'magicbricks:LEAD-77',
};

beforeEach(() => {
  vi.clearAllMocks();
  updates = [];
  inserted = [];
  createLeadImpl = null;
  createLeadArgs = null;
  createLeadResult = {
    lead: { id: 'lead-1', leadNo: 'LD-0001' },
    duplicates: [],
    created: true,
  };
});

describe('generic leads webhook receipt', () => {
  it('scopes every status write to the receipt it just created', async () => {
    const res: any = await (POST as any)(req(validBody), { params: Promise.resolve({}) });

    expect(res.status).toBe(200);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].status).toBe('RECEIVED');

    // The core regression: no write may reach the table unscoped, because an
    // unscoped update rewrites every other provider's receipt.
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) {
      expect(u.scope).toBe(RECEIPT_ID);
    }
    expect(updates[updates.length - 1].values.status).toBe('CREATED');
  });

  it('marks a redelivery DUPLICATE and points it at the existing lead', async () => {
    createLeadResult = { lead: { id: 'lead-9', leadNo: 'LD-0009' }, duplicates: [], created: false };

    const res: any = await (POST as any)(req(validBody), { params: Promise.resolve({}) });

    const last = updates[updates.length - 1];
    expect(last.values.status).toBe('DUPLICATE');
    expect(last.values.leadId).toBe('lead-9');
    expect(last.scope).toBe(RECEIPT_ID);
    // A retry is not a success and must not be reported as one.
    expect(res.body.duplicate).toBe(true);
    expect(res.body.ok).toBe(true);
  });

  it('marks an invalid payload ERROR on its own receipt only', async () => {
    const res: any = await (
      POST as any
    )(req({ provider: 'magicbricks', phone: '123' }), { params: Promise.resolve({}) });

    expect(res.status).toBe(422);
    expect(updates).toHaveLength(1);
    expect(updates[0].values.status).toBe('ERROR');
    expect(updates[0].scope).toBe(RECEIPT_ID);
    // Never reached, so no lead may be created.
    expect(inserted).toHaveLength(1);
  });

  it('keeps a failed delivery on RECEIVED and queues an INTEGRATION_SYNC retry', async () => {
    createLeadImpl = () => Promise.reject(new Error('assignment pool exhausted'));

    await expect(
      (POST as any)(req(validBody), { params: Promise.resolve({}) }),
    ).rejects.toThrow('assignment pool exhausted');

    // A transient failure (DB blip, empty assignment pool) is not a permanent
    // one, so the receipt must NOT be burned to ERROR: it stays RECEIVED as the
    // audit trail of an in-flight delivery, and the queue retries the sync.
    expect(updates).toHaveLength(0);

    // The retry is deduped by a digest key tied to the receipt, so a provider
    // redelivery of the same body (which creates a brand-new receipt) can never
    // double-queue the same retry.
    expect(enqueueJobOnceDetailed).toHaveBeenCalledTimes(1);
    expect(enqueueJobOnceDetailed).toHaveBeenCalledWith(
      'INTEGRATION_SYNC',
      { incomingId: RECEIPT_ID, actor: { id: 'actor-1' } },
      { digestKey: `integration:${RECEIPT_ID}`, maxAttempts: 4, runAt: expect.any(Date) },
    );
  });

  it('rejects a bad shared secret before writing any receipt', async () => {
    process.env.WEBHOOK_SECRET = 's3cret';
    try {
      const res: any = await (POST as any)(req(validBody), { params: Promise.resolve({}) });
      expect(res.status).toBe(403);
      expect(inserted).toHaveLength(0);
    } finally {
      delete process.env.WEBHOOK_SECRET;
    }
  });

  it('maps a provider `lead_id` onto sourceRef so redeliveries dedupe', async () => {
    const res: any = await (
      POST as any
    )(req({ provider: 'NINE9ACRES', name: 'Amit Kumar', phone: '9876500011', lead_id: 'ext_704188' }), {
      params: Promise.resolve({}),
    });

    expect(res.status).toBe(200);
    // Providers ship `lead_id` (ext_...) while the app dedups on sourceRef.
    // Without this alias every redelivery would create a brand-new lead.
    expect(createLeadArgs?.sourceRef).toBe('ext_704188');
    expect(createLeadArgs?.source).toBe('WEBSITE');
  });

  it('treats a redelivery of the same provider `lead_id` as a duplicate', async () => {
    createLeadResult = { lead: { id: 'lead-12', leadNo: 'LD-0012' }, duplicates: [], created: false };

    const res: any = await (
      POST as any
    )(req({ provider: 'MAGICBRICKS', name: 'Riya Kapoor', phone: '9876500022', lead_id: 'ext_853793' }), {
      params: Promise.resolve({}),
    });

    expect(res.status).toBe(200);
    expect(createLeadArgs?.sourceRef).toBe('ext_853793');
    expect(res.body.duplicate).toBe(true);
    const last = updates[updates.length - 1];
    expect(last.values.status).toBe('DUPLICATE');
    expect(last.scope).toBe(RECEIPT_ID);
  });
});
