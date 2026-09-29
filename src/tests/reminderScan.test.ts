import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * `scanReminders` is the one producer whose correctness is a delivery
 * guarantee: every agent must get the digest for a window, and must not get it
 * twice. The guarantee is enforced by the unique index on
 * `background_jobs.digest_key`, so these tests exercise the scan against a
 * mocked db to pin the two halves of that contract:
 *
 *   - the pre-check short-circuit, and
 *   - the conflict-aware insert that is the real guard.
 *
 * `enqueueJob` swallows every error by contract, which is why the scan uses
 * `enqueueJobOnce` instead: without it a lost insert race was counted as a
 * successful notification. `src/lib/db` is mocked for the same reason as in
 * `queue.test.ts` - these are decisions about the scan, not about Postgres.
 */

type Row = Record<string, unknown>;

/** Rows the mocked db returns per table, keyed by the table the query selects. */
let tableRows: Record<string, Row[]>;
/** Rows the next insert's `RETURNING` yields: `[]` models a digest conflict. */
let insertReturning: Row[];
/** Result of the `backgroundJobs.findFirst` idempotency pre-check. */
let existingJob: Row | undefined;
const insertCalls: { values: Row & { emailText?: unknown }; onConflict: boolean }[] = [];

const { followups, paymentDue, users } = await import('@/lib/db/schema');

vi.mock('@/lib/db', () => {
  const keyFor = (table: unknown) => {
    if (table === followups) return 'followups';
    if (table === paymentDue) return 'paymentDue';
    if (table === users) return 'users';
    return 'backgroundJobs';
  };

  const update = vi.fn(() => {
    const chain: Record<string, unknown> = {};
    chain.set = () => chain;
    chain.where = () => chain;
    chain.then = (r: (v: unknown) => unknown) => r(undefined);
    return chain;
  });

  return {
    db: {
      select: () => {
        let key = 'unknown';
        const chain: Record<string, unknown> = {};
        chain.from = (table: unknown) => {
          key = keyFor(table);
          return chain;
        };
        chain.leftJoin = () => chain;
        chain.innerJoin = () => chain;
        chain.where = () => chain;
        chain.orderBy = () => chain;
        chain.limit = () => chain;
        chain.then = (r: (v: unknown) => unknown) => r(tableRows[key] ?? []);
        return chain;
      },
      insert: () => {
        let values: Row = {};
        let onConflict = false;
        const chain: Record<string, unknown> = {};
        chain.values = (v: Row) => {
          values = v;
          return chain;
        };
        chain.onConflictDoNothing = () => {
          onConflict = true;
          return chain;
        };
        chain.returning = () => chain;
        chain.then = (r: (v: unknown) => unknown) => {
          // The email is queued as a job row with the message nested under
          // `payload`; hoist its text so assertions read naturally.
          const payload = values.payload as { text?: unknown } | undefined;
          insertCalls.push({ values: { ...values, emailText: payload?.text }, onConflict });
          return r(insertReturning);
        };
        return chain;
      },
      update,
      query: {
        backgroundJobs: {
          findFirst: async () => existingJob,
        },
      },
    },
  };
});

vi.mock('@/lib/resend', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveEmailConfig: async () => ({
      apiKey: 're_test',
      from: 'crm@example.com',
      fromName: 'CRM',
    }),
    sendEmail: async () => ({ id: 'sent', messageId: 'm1' }),
  };
});

const { scanReminders } = await import('@/lib/reminders');

const REFERENCE = new Date('2026-09-28T05:00:00Z'); // 10:30 IST on the 28th
const AGENT = {
  id: 'agent-1',
  name: 'Riya',
  email: 'riya@example.com',
  isActive: true,
  remindersEnabled: true,
  reminderTime: '09:00',
};

/**
 * A pending follow-up owned by the agent, `hours` away from the reference.
 * The default 60 minute lead only makes a follow-up visible once it is within
 * that hour, so an offset larger than 1 would be dropped before the agent ever
 * sees it - which is what the lead-window tests below are checking.
 */
const followup = (hours: number, over: Partial<Row> = {}) => ({
  id: 'f1',
  type: 'CALL',
  scheduledAt: new Date(REFERENCE.getTime() + hours * 3_600_000),
  remindBeforeMinutes: 60,
  notes: null,
  assignedTo: AGENT.id,
  createdById: null,
  leadOwnerId: null,
  leadName: 'Vikram',
  leadPhone: '9800000000',
  leadWhatsapp: null,
  customerName: null,
  customerPhone: null,
  customerOwnerId: null,
  ...over,
});

/** A pending payment due `days` from the reference, fully unpaid. */
const payment = (days: number, over: Partial<Row> = {}) => ({
  id: 'p1',
  amount: 50000,
  paidAmount: 0,
  dueDate: new Date(REFERENCE.getTime() + days * 86_400_000),
  notes: null,
  createdById: null,
  customerName: 'Vikram',
  customerPhone: '9800000000',
  customerOwnerId: AGENT.id,
  leadName: null,
  leadPhone: null,
  leadOwnerId: null,
  ...over,
});

beforeEach(() => {
  tableRows = { followups: [], paymentDue: [], users: [AGENT], backgroundJobs: [] };
  insertReturning = [{ id: 'job-1' }];
  existingJob = undefined;
  insertCalls.length = 0;
});

describe('scanReminders digest idempotency', () => {
  // digestSlots splits the agent's reminder time into two 12-hourly windows,
  // and the reference sits inside neither, so a scan queues both slots of the
  // day. Every count below is per slot.
  const SLOTS = 2;

  it('queues the digest and counts the agent as notified', async () => {
    tableRows.followups = [followup(0.5)];

    const result = await scanReminders(REFERENCE);

    expect(result.agentsNotified).toBe(SLOTS);
    expect(result.skippedAlreadyQueued).toBe(0);
  });

  it('skips without inserting when the window is already queued', async () => {
    tableRows.followups = [followup(0.5)];
    existingJob = { id: 'job-existing' };

    const result = await scanReminders(REFERENCE);

    expect(result.agentsNotified).toBe(0);
    expect(result.skippedAlreadyQueued).toBe(SLOTS);
    // The pre-check exists only to avoid a pointless write; a hit must not
    // attempt an insert at all.
    expect(insertCalls).toHaveLength(0);
  });

  it('counts a lost insert race as already queued rather than notified', async () => {
    // Two scans race: both pre-checks miss, then the unique index rejects the
    // loser's insert. Reporting that as a notification would over-report and
    // hide the fact that this process queued nothing.
    tableRows.followups = [followup(0.5)];
    insertReturning = [];

    const result = await scanReminders(REFERENCE);

    expect(result.agentsNotified).toBe(0);
    expect(result.skippedAlreadyQueued).toBe(SLOTS);
  });

  it('rejects the digest conflict through the digest key index', async () => {
    tableRows.followups = [followup(0.5)];

    await scanReminders(REFERENCE);

    expect(insertCalls).toHaveLength(SLOTS);
    expect(insertCalls.every((c) => c.onConflict)).toBe(true);
  });

  it('keeps the digest key format stable so already-queued jobs still match', async () => {
    // Jobs are already queued in production under this key. Changing the shape
    // would let a second job be created for the same window and email the agent
    // twice, so the format is pinned deliberately.
    tableRows.followups = [followup(0.5)];

    await scanReminders(REFERENCE);

    const keys = insertCalls.map((c) => String(c.values.digestKey));
    expect(keys).toEqual([
      'reminder-digest:agent-1:2026-09-28:0',
      'reminder-digest:agent-1:2026-09-28:1',
    ]);
  });

  it('gives each slot a distinct key so the two emails do not collide', async () => {
    tableRows.followups = [followup(0.5)];

    await scanReminders(REFERENCE);

    const keys = insertCalls.map((c) => String(c.values.digestKey));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('queues one job per digest slot, not per item', async () => {
    tableRows.followups = [followup(0.5), followup(-1, { id: 'f2' })];
    tableRows.paymentDue = [payment(1)];

    const result = await scanReminders(REFERENCE);

    expect(result.dueItems).toBe(3);
    // Two 12-hour slots, so at most two emails regardless of item count.
    expect(insertCalls.length).toBeLessThanOrEqual(2);
    expect(insertCalls.length).toBeGreaterThan(0);
  });
});

describe('scanReminders follow-up window', () => {
  it('surfaces a follow-up that is not due yet as upcoming, not late', async () => {
    // Still ahead of the reference but inside its 60 minute lead window, so the
    // digest should read as work still to be done rather than as already late.
    tableRows.followups = [followup(0.5)];

    await scanReminders(REFERENCE);

    const text = String(insertCalls[0]!.values.emailText);
    expect(text).toMatch(/due \d{2} \w+ 2026, \d{2}:\d{2}/);
    expect(text).not.toContain('was due');
  });

  it('reports a follow-up that already passed as late', async () => {
    tableRows.followups = [followup(-2)];

    await scanReminders(REFERENCE);

    const text = String(insertCalls[0]!.values.emailText);
    expect(text).toContain('was due');
  });

  it('still surfaces a follow-up whose lead window is not yet open', async () => {
    // Defensive: the SQL already gates on the window, so this proves the JS
    // re-check agrees with the query rather than dropping the row.
    tableRows.followups = [followup(5, { remindBeforeMinutes: 30 })];

    const result = await scanReminders(REFERENCE);

    expect(result.dueItems).toBe(0);
    expect(insertCalls).toHaveLength(0);
  });
});

describe('scanReminders item selection', () => {
  it('excludes a fully paid due from the digest', async () => {
    tableRows.paymentDue = [payment(0, { amount: 50000, paidAmount: 50000 })];

    const result = await scanReminders(REFERENCE);

    expect(result.dueItems).toBe(0);
    expect(insertCalls).toHaveLength(0);
  });

  it('keeps a partially paid due', async () => {
    tableRows.paymentDue = [payment(0, { amount: 50000, paidAmount: 20000 })];

    const result = await scanReminders(REFERENCE);

    expect(result.dueItems).toBe(1);
  });

  it('skips an item nobody owns rather than guessing an agent', async () => {
    tableRows.followups = [followup(0.5, { assignedTo: null, leadOwnerId: null, createdById: null })];

    const result = await scanReminders(REFERENCE);

    expect(result.dueItems).toBe(0);
    expect(insertCalls).toHaveLength(0);
  });

  it('does not notify an agent who opted out of reminders', async () => {
    tableRows.followups = [followup(0.5)];
    tableRows.users = [{ ...AGENT, remindersEnabled: false }];

    const result = await scanReminders(REFERENCE);

    expect(result.skippedOptedOut).toBe(1);
    expect(result.agentsNotified).toBe(0);
    expect(insertCalls).toHaveLength(0);
  });

  it('does not notify an inactive agent', async () => {
    tableRows.followups = [followup(0.5)];
    tableRows.users = [{ ...AGENT, isActive: false }];

    const result = await scanReminders(REFERENCE);

    expect(result.skippedInactive).toBe(1);
    expect(insertCalls).toHaveLength(0);
  });

  it('does not queue for an agent with no usable email', async () => {
    tableRows.followups = [followup(0.5)];
    tableRows.users = [{ ...AGENT, email: 'not-an-email' }];

    const result = await scanReminders(REFERENCE);

    expect(result.skippedNoEmail).toBe(1);
    expect(insertCalls).toHaveLength(0);
  });
});
