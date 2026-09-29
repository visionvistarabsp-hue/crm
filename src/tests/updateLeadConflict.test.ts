import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * `updateLead` sourceRef collision handling.
 *
 * `leads.source_ref` is unique, so two leads can never claim the same provider
 * ref. The webhook layer relies on that claim being exactly-one, and a raw
 * unique-violation surfacing as a 500 gives an operator no idea what happened.
 * These tests pin the contract: a patch that would steal a ref from another
 * lead fails fast with a clean 409 `SOURCE_REF_CONFLICT` naming the claimant,
 * re-saving a lead's own ref is a no-op, and a concurrent claimant that wins
 * between the pre-check and the UPDATE (the NOT EXISTS guard path) still loses
 * with the same 409. Clearing a ref cannot conflict, since NULLs are distinct.
 */

type Row = Record<string, unknown>;

let findFirstQueue: Array<Row | null>;
let updateReturning: Row[];
let findFirstCalls = 0;
const updateCalls: Row[] = [];

const existing = (over: Partial<Row> = {}): Row => ({
  id: 'lead-1',
  leadNo: 'LD-0001',
  name: 'Riya Shah',
  phone: '9876543210',
  email: 'riya@example.com',
  source: 'FACEBOOK',
  status: 'NEW',
  ownerId: 'owner-1',
  tags: [],
  metadata: {},
  sourceRef: 'meta:LEAD-1',
  ...over,
});

function chain(result: unknown) {
  const c: Record<string, unknown> = {};
  c.set = () => c;
  c.where = () => c;
  c.returning = () => updateReturning;
  c.then = (r: (v: unknown) => unknown) => r(result);
  return c;
}

const { leads, leadActivities } = await import('@/lib/db/schema');

vi.mock('@/lib/db', () => ({
  db: {
    query: {
      leads: {
        findFirst: () => {
          findFirstCalls += 1;
          return Promise.resolve(findFirstQueue.shift() ?? null);
        },
        findMany: () => Promise.resolve([]),
      },
    },
    update: (table: unknown) => {
      updateCalls.push({ table });
      return chain(updateReturning);
    },
    insert: (table: unknown) => {
      void table;
      const c = chain(undefined);
      c.values = () => c;
      c.onConflictDoNothing = () => c;
      c.returning = () => updateReturning;
      return c;
    },
    transaction: (fn: (tx: unknown) => Promise<void>) => fn({}),
  },
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    // Full-team access (returns null) so canAccessLead short-circuits and the
    // findFirst queue is only consumed by updateLead itself.
    resolveVisibleUserIds: () => Promise.resolve(null),
  };
});

vi.mock('@/lib/audit', () => ({
  writeAudit: () => Promise.resolve(undefined),
}));

vi.mock('@/lib/leadAlerts', () => ({
  markLeadTouched: () => Promise.resolve(undefined),
  notifyOwnerOfNewLead: () => Promise.resolve(undefined),
}));

const { updateLead } = await import('@/lib/services/leads');

const actor = { user: { id: 'user-1', role: 'ADMIN' } } as never;

beforeEach(() => {
  findFirstQueue = [existing()];
  updateReturning = [existing({ sourceRef: 'meta:LEAD-2' })];
  findFirstCalls = 0;
  updateCalls.length = 0;
});

describe('updateLead sourceRef collision', () => {
  it('throws a clean 409 naming the claimant when the ref belongs to another lead', async () => {
    // existing lookup, then the claimant pre-check.
    findFirstQueue = [existing(), existing({ id: 'lead-2', leadNo: 'LD-0002' })];

    const err = await updateLead(actor, 'lead-1', { sourceRef: 'meta:LEAD-2' }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(409);
    expect(err.code).toBe('SOURCE_REF_CONFLICT');
    expect(err.message).toContain('LD-0002');
    // Nothing was written.
    expect(updateCalls).toHaveLength(0);
  });

  it('re-saving a lead’s own ref is a no-op, not a collision', async () => {
    const res = await updateLead(actor, 'lead-1', { sourceRef: 'meta:LEAD-1' });

    expect(res?.leadNo).toBe('LD-0001');
    // The pre-check ran (existing lookup + claimant scan = 2 reads) and the
    // update still happened, proving the claim is exclusive to other leads only.
    expect(findFirstCalls).toBe(2);
    expect(updateCalls).toHaveLength(1);
  });

  it('a claimant that wins between pre-check and UPDATE still loses with a 409 (race)', async () => {
    // existing lookup finds the lead, the pre-check sees no claimant, but the
    // guarded UPDATE returns nothing because another tx claimed it first. The
    // re-read then surfaces the winner's identity.
    findFirstQueue = [existing(), null];
    updateReturning = [];

    const err = await updateLead(actor, 'lead-1', { sourceRef: 'meta:LEAD-9' }).catch((e) => e);

    expect(err.status).toBe(409);
    expect(err.code).toBe('SOURCE_REF_CONFLICT');
  });

  it('clearing a ref (null) cannot conflict and skips the claimant scan', async () => {
    const res = await updateLead(actor, 'lead-1', { sourceRef: null });

    expect(res?.leadNo).toBe('LD-0001');
    // Only the existing-lead lookup ran; no claimant scan, since NULLs are
    // distinct under the unique index and can never collide.
    expect(findFirstCalls).toBe(1);
    expect(updateCalls).toHaveLength(1);
  });

  it('leaves updates without a sourceRef untouched', async () => {
    const res = await updateLead(actor, 'lead-1', { priority: 'HIGH' });

    expect(res?.leadNo).toBe('LD-0001');
    expect(findFirstCalls).toBe(1);
  });
});
