import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The escalation scan is the half of lead alerting that must not be
 * over-eager. Two failure modes matter and they pull in opposite directions:
 *
 *   - escalating a lead that a human already worked on, which pages a manager
 *     for nothing and is the fastest way to get this feature switched off;
 *   - escalating the same lead twice, which is spam and is the failure mode a
 *     cron is uniquely prone to, because a tick that dies after sending still
 *     leaves a lead that the next tick will re-read.
 *
 * Both are enforced by the conditional claim on `escalated_at`, not by the
 * dedupe key, so the tests drive the scan against a mocked db and assert on
 * the claim itself. Postgres is not being tested here.
 */

type Row = Record<string, unknown>;

/** Rows returned by `db.select(...)` for the candidate scan. */
let candidateRows: Row[];
/**
 * Recipients handed back by `users.findFirst`, in call order.
 *
 * A queue rather than a single value because the scan makes two dependent
 * lookups - the owner, then the owner's manager (or a fallback admin) - and a
 * mock that always answered the first row would make the admin-fallback test
 * pass or fail for the wrong reason.
 */
let userQueue: Row[];
/** What the conditional escalation claim's `RETURNING` yields. `[]` = lost race. */
let claimReturning: Row[];
/** What `enqueueJobOnceDetailed` reports. `null` = a successful enqueue. */
let enqueueOutcome: { status: 'queued'; id: string } | { status: 'duplicate' } | { status: 'failed'; error: unknown } | null;

const notified: Array<{ userId: string; args: Record<string, unknown> }> = [];
const enqueued: Array<{ type: string; payload: Record<string, unknown>; digestKey: string }> = [];
const updates: Array<{ table: unknown; values: Row }> = [];
const updateReturning = vi.fn(() => claimReturning);

const { leads, users } = await import('@/lib/db/schema');

/** Chainable stand-in for a drizzle update/query builder. */
function chain(result: unknown) {
  const c: Record<string, unknown> = {};
  c.set = (values: Row) => {
    updates.push({ table: currentTable, values });
    return c;
  };
  c.where = () => c;
  c.orderBy = () => c;
  c.limit = () => c;
  c.returning = () => updateReturning();
  c.then = (r: (v: unknown) => unknown) => r(result);
  // The rollback path chains `.catch` onto the builder.
  c.catch = (cb: (e: unknown) => unknown) => {
    if (result instanceof Error) cb(result);
    return c;
  };
  return c;
}

let currentTable: unknown;

vi.mock('@/lib/db', () => ({
  db: {
    select: () => {
      const c: Record<string, unknown> = {};
      c.from = (table: unknown) => {
        currentTable = table;
        return chain(candidateRows);
      };
      c.where = () => chain(candidateRows);
      c.orderBy = () => chain(candidateRows);
      c.limit = () => chain(candidateRows);
      return c;
    },
    update: (table: unknown) => {
      currentTable = table;
      return chain([]);
    },
    query: {
      leads: {
        findFirst: () => Promise.resolve(candidateRows[0] ?? null),
      },
      users: {
        findFirst: () => Promise.resolve(userQueue.shift() ?? null),
      },
    },
  },
}));

vi.mock('@/lib/notifications', () => ({
  notifyUser: (userId: string, args: Record<string, unknown>) => {
    notified.push({ userId, args });
  },
}));

vi.mock('@/lib/queue', () => ({
  enqueueJobOnceDetailed: (
    type: string,
    payload: Record<string, unknown>,
    opts: { digestKey: string },
  ) => {
    if (enqueueOutcome === null) {
      enqueued.push({ type, payload, digestKey: opts.digestKey });
      return Promise.resolve({ status: 'queued', id: 'job-1' });
    }
    if (enqueueOutcome.status !== 'failed') enqueued.push({ type, payload, digestKey: opts.digestKey });
    return Promise.resolve(enqueueOutcome);
  },
}));

const { scanUnclaimedLeads, markLeadTouched, notifyOwnerOfNewLead, broadcastNewLeadToTeam } = await import('@/lib/leadAlerts');

const lead = (over: Partial<Row> = {}): Row => ({
  id: 'lead-1',
  leadNo: 'LD-1',
  name: 'Riya Shah',
  phone: '+919000000001',
  email: 'riya@example.com',
  source: 'META',
  isDuplicate: false,
  ownerId: 'owner-1',
  ...over,
});

const owner = (over: Partial<Row> = {}): Row => ({
  id: 'owner-1',
  name: 'Dev',
  email: 'dev@example.com',
  newLeadAlertsEnabled: true,
  managerId: 'manager-1',
  ...over,
});

const manager = (over: Partial<Row> = {}): Row => ({
  id: 'manager-1',
  name: 'Priya',
  email: 'priya@example.com',
  newLeadAlertsEnabled: true,
  managerId: null,
  ...over,
});

beforeEach(() => {
  candidateRows = [];
  userQueue = [];
  claimReturning = [{ id: 'lead-1' }];
  enqueueOutcome = null;
  notified.length = 0;
  enqueued.length = 0;
  updates.length = 0;
  currentTable = null;
});

describe('scanUnclaimedLeads', () => {
  it('pages the manager and stamps escalated_at for an unclaimed old lead', async () => {
    candidateRows = [lead()];
    // Lookup order: the owner, then the owner's manager.
    userQueue = [owner(), manager()];

    const result = await scanUnclaimedLeads();

    expect(result.escalated).toBe(1);
    expect(enqueued).toHaveLength(1);
    // The digest is per lead, not per recipient, so a re-tick cannot re-page.
    expect(enqueued[0].digestKey).toBe('lead-escalation:lead-1');
    expect(enqueued[0].payload).toMatchObject({ to: 'priya@example.com' });
    expect(notified[0].userId).toBe('manager-1');
    expect(updates.some((u) => u.table === leads && 'escalatedAt' in u.values)).toBe(true);
  });

  it('does not escalate when a concurrent tick already claimed the row', async () => {
    candidateRows = [lead()];
    userQueue = [owner(), manager()];
    // The conditional UPDATE ... WHERE escalated_at IS NULL matched no rows.
    claimReturning = [];

    const result = await scanUnclaimedLeads();

    expect(result.escalated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(notified).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });

  it('skips a lead with no owner rather than paging a fallback admin', async () => {
    candidateRows = [lead({ ownerId: null })];

    const result = await scanUnclaimedLeads();

    expect(result.skippedNoManager).toBe(1);
    expect(result.escalated).toBe(0);
    expect(enqueued).toHaveLength(0);
  });

  it('falls back to an active admin when the owner has no manager', async () => {
    candidateRows = [lead()];
    // Lookup order: the owner (no managerId), then the admin fallback.
    userQueue = [owner({ managerId: null }), manager({ id: 'admin-1' })];

    const result = await scanUnclaimedLeads();

    expect(result.escalated).toBe(1);
    expect(notified[0].userId).toBe('admin-1');
  });

  it('releases the claim when the email could not be queued', async () => {
    candidateRows = [lead()];
    userQueue = [owner(), manager()];
    enqueueOutcome = { status: 'failed', error: new Error('queue insert failed') };

    const result = await scanUnclaimedLeads();

    // The in-app page still landed, but nothing was queued for email.
    expect(result.emailFailures).toBe(1);
    expect(result.escalated).toBe(0);
    // Claim released so the next tick retries instead of losing the email.
    expect(updates.some((u) => u.table === leads && u.values.escalatedAt === null)).toBe(true);
  });

  it('keeps the claim when the email is a duplicate, since the page is owed', async () => {
    candidateRows = [lead()];
    userQueue = [owner(), manager()];
    enqueueOutcome = { status: 'duplicate' };

    const result = await scanUnclaimedLeads();

    // An identical job is already pending, so this is not a failure and the
    // row must stay claimed or a re-tick would page again.
    expect(result.emailFailures).toBe(0);
    expect(result.escalated).toBe(1);
    expect(updates.some((u) => u.table === leads && u.values.escalatedAt === null)).toBe(false);
  });

  it('falls back to an admin when the manager has muted alerts', async () => {
    candidateRows = [lead()];
    // Owner, muted manager, then the admin who catches the lead instead.
    userQueue = [owner(), manager({ newLeadAlertsEnabled: false }), manager({ id: 'admin-1' })];

    const result = await scanUnclaimedLeads();

    expect(result.escalated).toBe(1);
    expect(notified[0].userId).toBe('admin-1');
  });

  it('claims nothing when nobody reachable wants the alert', async () => {
    candidateRows = [lead()];
    // Owner, muted manager, and no admin available.
    userQueue = [owner(), manager({ newLeadAlertsEnabled: false })];

    const result = await scanUnclaimedLeads();

    expect(result.skippedNoManager).toBe(1);
    expect(result.escalated).toBe(0);
    expect(notified).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
    // Not claimed, so the lead is re-evaluated if an opt-in admin appears.
    expect(updates.some((u) => u.table === leads && 'escalatedAt' in u.values)).toBe(false);
  });
});

describe('notifyOwnerOfNewLead', () => {
  it('sends the owner alert under a per-recipient digest key', async () => {
    candidateRows = [lead()];
    userQueue = [owner()];

    await notifyOwnerOfNewLead(lead() as never);

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].digestKey).toBe('lead-alert:lead-1:owner-1');
    expect(notified[0].userId).toBe('owner-1');
  });

  it('is a no-op when the lead has no owner yet', async () => {
    candidateRows = [lead({ ownerId: null })];

    await notifyOwnerOfNewLead(lead({ ownerId: null }) as never);

    expect(enqueued).toHaveLength(0);
    expect(notified).toHaveLength(0);
  });

  it('still alerts the owner when the lead has no contact details', async () => {
    // A lead with no phone and no email is still a real lead. The name,
    // number and source are enough for the owner to act, so suppressing here
    // would silently drop the alert for the leads least worth dropping.
    candidateRows = [lead({ phone: null, email: null })];
    userQueue = [owner()];

    await notifyOwnerOfNewLead(lead({ phone: null, email: null }) as never);

    expect(notified).toHaveLength(1);
    expect(enqueued).toHaveLength(1);
  });

  it('sends nothing to an owner who has muted lead alerts', async () => {
    candidateRows = [lead()];
    userQueue = [owner({ newLeadAlertsEnabled: false })];

    await notifyOwnerOfNewLead(lead() as never);

    expect(notified).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });
});

describe('markLeadTouched', () => {
  it('only stamps the first touch', async () => {
    await markLeadTouched('lead-1');

    const touch = updates.find((u) => u.table === leads && 'firstTouchedAt' in u.values);
    expect(touch).toBeDefined();
    expect(touch?.values.firstTouchedAt).toBeInstanceOf(Date);
  });

  it('never throws, so a failed stamp cannot fail the user edit', async () => {
    // A rejected chain models the DB error; the guard must absorb it.
    const { db } = await import('@/lib/db');
    const spy = vi.spyOn(db, 'update').mockImplementationOnce(() => {
      throw new Error('db down');
    });

    await expect(markLeadTouched('lead-1')).resolves.toBeUndefined();
    spy.mockRestore();
  });
});

describe('broadcastNewLeadToTeam', () => {
  it('emails every active user under a per-user digest key', async () => {
    candidateRows = [
      { id: 'u1', email: 'riya@example.com' },
      { id: 'u2', email: 'dev@example.com' },
    ];

    const result = await broadcastNewLeadToTeam(lead() as never);

    expect(result.emailed).toBe(2);
    expect(result.skippedNoEmail).toBe(0);
    expect(enqueued).toHaveLength(2);
    expect(enqueued.map((j) => j.digestKey).sort()).toEqual([
      'lead-broadcast:lead-1:u1',
      'lead-broadcast:lead-1:u2',
    ]);
    expect(enqueued[0].payload).toMatchObject({ to: 'riya@example.com', subject: 'New lead: Riya Shah' });
  });

  it('skips users with no usable email address', async () => {
    candidateRows = [
      { id: 'u1', email: 'riya@example.com' },
      { id: 'u2', email: 'not-an-email' },
      { id: 'u3', email: null },
    ];

    const result = await broadcastNewLeadToTeam(lead() as never);

    expect(result.emailed).toBe(1);
    expect(result.skippedNoEmail).toBe(2);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].digestKey).toBe('lead-broadcast:lead-1:u1');
  });

  it('ignores the per-user new-lead mute: the broadcast is team-wide', async () => {
    // The muted user still gets the email; `newLeadAlertsEnabled` only gates
    // the owner/manager pages, not the whole-team announcement.
    candidateRows = [
      { id: 'u1', email: 'riya@example.com', newLeadAlertsEnabled: false },
    ];

    const result = await broadcastNewLeadToTeam(lead() as never);

    expect(result.emailed).toBe(1);
    expect(enqueued[0].digestKey).toBe('lead-broadcast:lead-1:u1');
  });
});
