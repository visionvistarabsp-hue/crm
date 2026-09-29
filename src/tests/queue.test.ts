import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Queue behaviour that is easy to regress: the drainer must actually run a
 * handler, must retry a flaky handler, and must give up exactly when
 * maxAttempts is reached. `enqueueJob` is best-effort by contract, so a broken
 * queue must never surface to the caller that produced the work.
 *
 * `src/lib/db` throws on import without DATABASE_URL and hands out a live pg
 * Pool otherwise, so it is mocked: these tests are about the queue's own
 * decisions, not about Postgres.
 */
const insert = vi.fn();
const select = vi.fn();
const update = vi.fn();

vi.mock('@/lib/db', () => ({
  db: {
    insert: (...a: unknown[]) => insert(...a),
    select: (...a: unknown[]) => select(...a),
    update: (...a: unknown[]) => update(...a),
  },
}));

const { backgroundJobs } = await import('@/lib/db/schema');
const { enqueueJob, registerJobHandler, processDueJobs, setTimeoutAsync, QueueError } = await import(
  '@/lib/queue'
);

/** Drizzle chain that resolves to `rows`, recording any `.values()`/`.set()`. */
const chain = (rows: unknown[]) => {
  const c: Record<string, unknown> = { args: undefined as unknown };
  c.from = () => c;
  c.where = () => c;
  c.orderBy = () => c;
  c.limit = () => c;
  c.values = (v: unknown) => {
    c.args = v;
    return c;
  };
  c.set = (v: unknown) => {
    c.args = v;
    return c;
  };
  c.then = (r: (v: unknown) => unknown) => r(rows);
  return c;
};

/** Payload of the nth `db.insert(...)` / `db.update(...)` call. */
const nthArg = (fn: typeof insert, i: number) => (fn.mock.results[i]?.value as { args: any })?.args;
const lastArg = (fn: typeof insert) =>
  (fn.mock.results[fn.mock.results.length - 1]?.value as { args: any })?.args;

const job = (over: Record<string, unknown> = {}) => ({
  id: 'job-1',
  type: 'REMINDER',
  payload: { agentId: 'u1' },
  status: 'PENDING',
  attempts: 0,
  maxAttempts: 3,
  priority: 5,
  ...over,
});

beforeEach(() => {
  insert.mockReset();
  select.mockReset();
  update.mockReset();
});

describe('enqueueJob', () => {
  it('never throws when the queue is unavailable', async () => {
    insert.mockImplementation(() => {
      throw new Error('database is down');
    });
    // Best-effort: the primary operation (recording a payment, say) must
    // succeed even if the follow-up job could not be queued.
    await expect(enqueueJob('REMINDER', { agentId: 'u1' })).resolves.toBeUndefined();
  });

  it('never throws when the insert rejects', async () => {
    insert.mockReturnValue(Promise.reject(new Error('connection refused')));
    await expect(enqueueJob('REMINDER', { agentId: 'u1' })).resolves.toBeUndefined();
  });

  it('writes a job with safe defaults', async () => {
    insert.mockImplementation(() => chain([]));
    await enqueueJob('REMINDER', { agentId: 'u1' });
    expect(insert.mock.calls[0][0]).toBe(backgroundJobs);
    const values = nthArg(insert, 0);
    expect(values.payload).toEqual({ agentId: 'u1' });
    expect(values.priority).toBe(5);
    expect(values.maxAttempts).toBe(3);
    // No idempotency key by default: a plain job may legitimately repeat.
    expect(values.digestKey).toBeNull();
    expect(values.runAt).toBeInstanceOf(Date);
  });

  it('carries the idempotency key through so a re-run cannot double-enqueue', async () => {
    insert.mockImplementation(() => chain([]));
    const key = 'reminder-digest:u1:2026-09-28';
    await enqueueJob('REMINDER', { agentId: 'u1' }, { digestKey: key, runAt: new Date(0) });
    const values = nthArg(insert, 0);
    expect(values.digestKey).toBe(key);
    expect(values.runAt).toEqual(new Date(0));
  });
});

describe('processDueJobs', () => {
  it('runs the handler and marks the job DONE', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    registerJobHandler('REMINDER', handler);
    select.mockImplementation(() => chain([job()]));
    update.mockImplementation(() => chain([]));

    await expect(processDueJobs()).resolves.toBe(1);
    expect(handler).toHaveBeenCalledWith({ agentId: 'u1' });

    const sets = update.mock.results.map((r) => (r.value as { args: { status: string } }).args.status);
    expect(sets).toEqual(['PROCESSING', 'DONE']);
  });

  it('skips a job whose type has no registered handler', async () => {
    select.mockImplementation(() => chain([job({ type: 'WHATSAPP' })]));
    update.mockImplementation(() => chain([]));
    // Left PENDING for a later pass rather than being burned as a failure.
    await expect(processDueJobs()).resolves.toBe(0);
    expect(update).not.toHaveBeenCalled();
  });

  it('retries a flaky handler and succeeds on a later attempt', async () => {
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error('smtp timeout'))
      .mockResolvedValue(undefined);
    registerJobHandler('REMINDER', handler);
    select.mockImplementation(() => chain([job()]));
    update.mockImplementation(() => chain([]));

    await expect(processDueJobs()).resolves.toBe(1);
    expect(handler).toHaveBeenCalledTimes(2);
    const sets = update.mock.results.map((r) => (r.value as { args: { status: string } }).args.status);
    expect(sets).toEqual(['PROCESSING', 'DONE']);
  });

  it('requeues as PENDING and records the error when attempts remain', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('smtp timeout'));
    registerJobHandler('REMINDER', handler);
    select.mockImplementation(() => chain([job({ attempts: 0, maxAttempts: 3 })]));
    update.mockImplementation(() => chain([]));

    await expect(processDueJobs()).resolves.toBe(0);
    // maxAttempts=3 and attempts was 0, so one retry is still allowed.
    const values = lastArg(update);
    expect(values.status).toBe('PENDING');
    expect(values.lastError).toBe('smtp timeout');
    expect(values.attempts).toBe(1);
  });

  it('gives up as FAILED once maxAttempts is reached', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('smtp timeout'));
    registerJobHandler('REMINDER', handler);
    // attempts=2 of maxAttempts=3: this run is the last allowed attempt.
    select.mockImplementation(() => chain([job({ attempts: 2, maxAttempts: 3 })]));
    update.mockImplementation(() => chain([]));

    await expect(processDueJobs()).resolves.toBe(0);
    expect(handler).toHaveBeenCalledTimes(1);
    const values = lastArg(update);
    expect(values.status).toBe('FAILED');
    expect(values.attempts).toBe(3);
  });

  it('retries exactly maxAttempts times before giving up in one drain', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('smtp timeout'));
    registerJobHandler('REMINDER', handler);
    select.mockImplementation(() => chain([job({ attempts: 0, maxAttempts: 3 })]));
    update.mockImplementation(() => chain([]));

    await processDueJobs();
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('does not retry a job with a single allowed attempt', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('smtp timeout'));
    registerJobHandler('REMINDER', handler);
    select.mockImplementation(() => chain([job({ attempts: 0, maxAttempts: 1 })]));
    update.mockImplementation(() => chain([]));

    await expect(processDueJobs()).resolves.toBe(0);
    expect(handler).toHaveBeenCalledTimes(1);
    const values = lastArg(update);
    expect(values.status).toBe('FAILED');
  });
});

describe('setTimeoutAsync', () => {
  it('waits before running and returns the result', async () => {
    const started = Date.now();
    await expect(setTimeoutAsync(async () => 'sent', 30)).resolves.toBe('sent');
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });
});

describe('QueueError', () => {
  it('preserves the underlying cause', () => {
    const cause = new Error('ECONNRESET');
    const err = new QueueError('could not enqueue', cause);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('could not enqueue');
    expect(err.cause).toBe(cause);
  });
});
