import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Webhook idempotency for lead creation.
 *
 * Providers are at-least-once. Meta re-delivers a lead event whenever it does
 * not get a 2xx, and will double-deliver on an ambiguous timeout, so the same
 * `leadgen_id` can reach `createLead` two or more times. That matters more than
 * a wasted row: every creation also runs assignment, automations, audit and -
 * since the alert work - an email to a real owner. A retry must therefore be
 * observably a no-op, not a second lead.
 *
 * The guarantee is the unique index on `leads.source_ref`; these tests drive
 * `createLead` against a mocked db to prove the *consequences* of losing that
 * insert race are correct. Postgres index behaviour itself is not under test.
 */

type Row = Record<string, unknown>;

/**
 * Rows handed back by `leads.findFirst`, in call order.
 *
 * A queue rather than a map keyed on the ref, because parsing drizzle's `eq()`
 * internals in a mock is brittle. The dedupe path makes at most two such
 * lookups - the pre-check, then the re-read after losing the insert race - and
 * a queue lets each test state "the first lookup finds nothing, the second finds
 * the winner", which is exactly the race being simulated.
 */
let findFirstQueue: Array<Row | null>;
/** What the insert's `RETURNING` yields. `[]` = lost the conflict race. */
let insertReturning: Row[];
/** Whether the insert carried the ON CONFLICT clause. */
let usedOnConflict = false;

const insertCalls: Row[] = [];
const assigned: string[] = [];
const automated: string[] = [];
const audited: string[] = [];
const alerted: string[] = [];
const statusHistory: Row[] = [];
const activities: Row[] = [];

const existing = (over: Partial<Row> = {}): Row => ({
  id: 'lead-1',
  leadNo: 'LD-0001',
  name: 'Riya Shah',
  phone: '9876543210',
  whatsapp: '9876543210',
  email: 'riya@example.com',
  source: 'META',
  status: 'NEW',
  ownerId: 'owner-1',
  projectId: null,
  tags: [],
  metadata: {},
  isDuplicate: false,
  createdById: 'user-1',
  ...over,
});

function chain(result: unknown) {
  const c: Record<string, unknown> = {};
  c.values = (v: Row) => {
    insertCalls.push(v);
    return c;
  };
  c.onConflictDoNothing = (opts: { target: unknown }) => {
    usedOnConflict = true;
    void opts;
    return c;
  };
  c.returning = () => insertReturning;
  c.where = () => c;
  c.then = (r: (v: unknown) => unknown) => r(result);
  return c;
}

const { leads, leadActivities, leadStatusHistory } = await import('@/lib/db/schema');

vi.mock('@/lib/db', () => ({
  db: {
    query: {
      leads: {
        findFirst: () => Promise.resolve(findFirstQueue.shift() ?? null),
        // Identity-duplicate scan. Empty here because the advisory phone/email
        // check is orthogonal to the source-ref guarantee under test, and is
        // covered in duplicates.test.ts.
        findMany: () => Promise.resolve([]),
      },
    },
    insert: () => chain([]),
    transaction: (fn: (tx: unknown) => Promise<void>) =>
      fn({
        // The lead insert, its status-history row and its activity row all go
        // through one builder shape, so they are told apart by table identity
        // rather than by string-matching the table.
        insert: (table: unknown) => {
          if (table === leadStatusHistory) return historyChain();
          if (table === leadActivities) return activityChain();
          return chain([]);
        },
      }),
  },
}));

function historyChain() {
  const c = chain([]);
  const orig = c.values;
  c.values = (v: Row) => (statusHistory.push(v), orig);
  return c;
}

function activityChain() {
  const c = chain([]);
  const orig = c.values;
  c.values = (v: Row) => (activities.push(v), orig);
  return c;
}

vi.mock('@/lib/services/counters', () => ({
  nextNumber: () => Promise.resolve('LD-0001'),
}));

vi.mock('@/lib/services/assignment', () => ({
  assignLead: ({ lead }: { lead: Row }) => {
    assigned.push(String(lead.id));
    return Promise.resolve(lead);
  },
}));

vi.mock('@/lib/services/automation', () => ({
  runAutomations: (_event: string, payload: { leadId: string }) => {
    automated.push(payload.leadId);
    return Promise.resolve();
  },
}));

vi.mock('@/lib/audit', () => ({
  writeAudit: (args: { entityId: string }) => {
    audited.push(args.entityId);
    return Promise.resolve();
  },
}));

vi.mock('@/lib/leadAlerts', () => ({
  markLeadTouched: () => Promise.resolve(undefined),
  notifyOwnerOfNewLead: (lead: Row) => {
    alerted.push(String(lead.id));
    return Promise.resolve();
  },
  broadcastNewLeadToTeam: () => Promise.resolve({ emailed: 0, skippedNoEmail: 0 }),
}));

const { createLead } = await import('@/lib/services/leads');

const payload = {
  name: 'Riya Shah',
  phone: '98765 43210',
  email: 'Riya@Example.com',
  // Meta resolves to a concrete channel before the lead is written, so the
  // persisted source is FACEBOOK/INSTAGRAM, not 'META'.
  source: 'FACEBOOK',
  sourceRef: 'meta-facebook:LEAD-1',
};

beforeEach(() => {
  findFirstQueue = [null];
  insertReturning = [existing()];
  usedOnConflict = false;
  insertCalls.length = 0;
  assigned.length = 0;
  automated.length = 0;
  audited.length = 0;
  alerted.length = 0;
  statusHistory.length = 0;
  activities.length = 0;
});

describe('createLead webhook idempotency', () => {
  it('returns the existing lead and skips every side effect on a redelivery', async () => {
    findFirstQueue = [existing()];

    const res = await createLead({ user: { id: 'user-1' } } as never, payload);

    expect(res.created).toBe(false);
    expect(res.lead.id).toBe('lead-1');
    // A redelivery must not insert, assign, automate, audit or alert - the
    // alert is the part that reaches a real inbox.
    expect(insertCalls).toHaveLength(0);
    expect(assigned).toEqual([]);
    expect(automated).toEqual([]);
    expect(audited).toEqual([]);
    expect(alerted).toEqual([]);
  });

  it('reports duplicates as empty on a redelivery rather than re-flagging them', async () => {
    findFirstQueue = [existing()];

    const res = await createLead({ user: { id: 'user-1' } } as never, payload);

    expect(res.duplicates).toEqual([]);
  });

  it('creates, assigns and alerts exactly once on a first delivery', async () => {
    const res = await createLead({ user: { id: 'user-1' } } as never, payload);

    expect(res.created).toBe(true);
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].sourceRef).toBe('meta-facebook:LEAD-1');
    expect(assigned).toEqual(['lead-1']);
    expect(automated).toEqual(['lead-1']);
    expect(audited).toEqual(['lead-1']);
    // The owner alert is detached, so it is asserted synchronously via the
    // mock rather than awaited.
    expect(alerted).toEqual(['lead-1']);
    expect(statusHistory).toHaveLength(1);
    expect(activities).toHaveLength(1);
  });

  it('uses the unique index as the arbiter, not the pre-check', async () => {
    // Two deliveries race: both pass the pre-check, then one loses the insert.
    // The loser must resolve to the winner's row instead of throwing.
    findFirstQueue = [null, existing({ id: 'lead-winner' })];
    insertReturning = [];

    const res = await createLead({ user: { id: 'user-1' } } as never, payload);

    expect(usedOnConflict).toBe(true);
    expect(res.created).toBe(false);
    expect(res.lead.id).toBe('lead-winner');
    expect(assigned).toEqual([]);
    expect(automated).toEqual([]);
    expect(audited).toEqual([]);
    expect(alerted).toEqual([]);
  });

  it('leads without a sourceRef insert unconditionally, since NULLs never conflict', async () => {
    const res = await createLead({ user: { id: 'user-1' } } as never, {
      name: 'Manual Entry',
      phone: '9000000000',
      source: 'MANUAL',
    });

    expect(res.created).toBe(true);
    expect(usedOnConflict).toBe(false);
    expect(assigned).toEqual(['lead-1']);
  });
});
