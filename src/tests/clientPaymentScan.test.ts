import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * `scanClientPaymentReminders` is a delivery contract: a client gets exactly
 * two emails per outstanding payment - "due tomorrow" on the eve of the local
 * due day and "due today" on the day itself - and never any email for a
 * payment that has already gone due. The guard is the unique index on
 * `background_jobs.digest_key`, so these tests run the scan against a mocked db
 * to pin the two halves: the `findFirst` pre-check short-circuit and the
 * conflict-aware insert, plus the "email not configured" early return.
 */

type Row = Record<string, unknown>;

/** Rows the mocked db returns per table, keyed by the table the query selects. */
let tableRows: Record<string, Row[]>;
/** Rows the next insert's `RETURNING` yields: `[]` models a digest conflict. */
let insertReturning: Row[];
/** Result of the `backgroundJobs.findFirst` idempotency pre-check. */
let existingJob: Row | undefined;
/** What `resolveEmailConfig` reports; `null` models "email not configured". */
let emailConfig: Row | null;
const insertCalls: { values: Row; onConflict: boolean }[] = [];
type EmailPayload = { to?: unknown; subject?: unknown; text?: unknown };
/** The email message the real `enqueueJobOnce` nested under `payload`. */
const payloadOf = (call: { values: Row }): EmailPayload =>
  (call.values.payload as EmailPayload | undefined) ?? {};

const { paymentDue } = await import('@/lib/db/schema');

vi.mock('@/lib/db', () => {
  const keyFor = (table: unknown) => {
    if (table === paymentDue) return 'paymentDue';
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
          insertCalls.push({ values, onConflict });
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
    resolveEmailConfig: async () => emailConfig,
    sendEmail: async () => ({ id: 'sent', messageId: 'm1' }),
  };
});

const { scanClientPaymentReminders } = await import('@/lib/reminders');

const originalTz = process.env.APP_TIMEZONE;
beforeEach(() => {
  process.env.APP_TIMEZONE = 'Asia/Kolkata';
  tableRows = {};
  insertReturning = [{ id: 'job-1' }];
  existingJob = undefined;
  emailConfig = { apiKey: 're_test', from: 'crm@example.com', fromName: 'CRM' };
  insertCalls.length = 0;
});

afterEach(() => {
  if (originalTz === undefined) delete process.env.APP_TIMEZONE;
  else process.env.APP_TIMEZONE = originalTz;
});

/** 02:00 UTC = 07:30 IST, before the 09:00 IST send hour on the reference day. */
const REFERENCE = new Date('2026-09-28T02:00:00Z');
const dueRow = (over: Partial<Row> = {}): Row => ({
  id: 'p1',
  // Local date is the 29th in IST (05:30 start).
  dueDate: new Date('2026-09-29T00:00:00Z'),
  amount: 50000,
  paidAmount: 0,
  customerName: 'Aarav',
  customerEmail: 'aarav@example.com',
  leadName: null,
  leadEmail: null,
  ...over,
});

describe('scanClientPaymentReminders', () => {
  it('queues the "due tomorrow" and "due today" emails for tomorrow\'s payment', async () => {
    tableRows.paymentDue = [dueRow()];

    const result = await scanClientPaymentReminders(REFERENCE);

    expect(result.remindersQueued).toBe(2);
    expect(result.skippedNoEmail).toBe(0);
    expect(result.emailConfigured).toBe(true);
    expect(insertCalls.map((c) => c.values.digestKey).sort()).toEqual([
      'client-payment:p1:2026-09-29:before',
      'client-payment:p1:2026-09-29:due',
    ]);
    // Both land on the configured 09:00 IST slot of their own local day.
    expect(insertCalls.map((c) => (c.values.runAt as Date).toISOString()).sort()).toEqual([
      '2026-09-28T03:30:00.000Z',
      '2026-09-29T03:30:00.000Z',
    ]);
    expect(payloadOf(insertCalls[0])).toMatchObject({
      to: 'aarav@example.com',
      subject: 'Payment due tomorrow: ₹50,000',
    });
  });

  it('queues only the "due today" email when the eve slot already passed', async () => {
    // Due today in IST; the 09:00 IST eve slot was yesterday.
    tableRows.paymentDue = [dueRow({ dueDate: new Date('2026-09-28T00:00:00Z') })];

    const result = await scanClientPaymentReminders(REFERENCE);

    expect(result.remindersQueued).toBe(1);
    expect(insertCalls.map((c) => c.values.digestKey)).toEqual([
      'client-payment:p1:2026-09-28:due',
    ]);
    expect(payloadOf(insertCalls[0])).toMatchObject({
      to: 'aarav@example.com',
      subject: 'Payment due today: ₹50,000',
    });
  });

  it('falls back to the lead email and name when the customer has none', async () => {
    tableRows.paymentDue = [
      dueRow({ customerEmail: null, customerName: null, leadName: 'Riya', leadEmail: 'riya@example.com' }),
    ];

    const result = await scanClientPaymentReminders(REFERENCE);

    expect(result.remindersQueued).toBe(2);
    expect(insertCalls.every((c) => payloadOf(c).to === 'riya@example.com')).toBe(true);
    expect(payloadOf(insertCalls[0]).text).toContain('Hi Riya,');
  });

  it('skips a payment with no usable contact instead of inventing an address', async () => {
    tableRows.paymentDue = [
      dueRow({ customerEmail: '   ', customerName: null, leadName: null, leadEmail: null }),
    ];

    const result = await scanClientPaymentReminders(REFERENCE);

    expect(result.remindersQueued).toBe(0);
    expect(result.skippedNoEmail).toBe(1);
    expect(insertCalls).toHaveLength(0);
  });

  it('does not re-queue touches whose digest key already has a job', async () => {
    tableRows.paymentDue = [dueRow()];
    existingJob = { id: 'job-0' };

    const result = await scanClientPaymentReminders(REFERENCE);

    expect(result.remindersQueued).toBe(0);
    expect(result.skippedAlreadyQueued).toBe(2);
    expect(insertCalls).toHaveLength(0);
  });

  it('never emails a payment that has already gone past its due day', async () => {
    // Local date is the 27th in IST - before the reference day's midnight.
    tableRows.paymentDue = [dueRow({ dueDate: new Date('2026-09-27T00:00:00Z') })];

    const result = await scanClientPaymentReminders(REFERENCE);

    expect(result.skippedPastDue).toBe(1);
    expect(result.remindersQueued).toBe(0);
    expect(insertCalls).toHaveLength(0);
  });

  it('returns immediately when email is not configured', async () => {
    emailConfig = null;
    tableRows.paymentDue = [dueRow()];

    const result = await scanClientPaymentReminders(REFERENCE);

    expect(result.emailConfigured).toBe(false);
    expect(result.remindersQueued).toBe(0);
    expect(insertCalls).toHaveLength(0);
  });
});