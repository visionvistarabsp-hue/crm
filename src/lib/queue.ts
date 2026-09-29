import { db } from './db';
import { backgroundJobs } from './db/schema';
import { and, lt, lte, eq, asc } from 'drizzle-orm';

export type JobType = 'NOTIFY' | 'REMINDER' | 'AUTOMATION' | 'EMAIL' | 'WHATSAPP' | 'INTEGRATION_SYNC';

/**
 * Bounded exponential backoff for INTEGRATION_SYNC retries only.
 *
 * A webhook failure is likely transient (DB blip, momentarily empty assignment
 * pool), so immediate requeue just replays the same failure on every cron tick.
 * Every other job type keeps its current behavior - immediate PENDING requeue -
 * to avoid changing reminder/notification semantics.
 */
const INTEGRATION_SYNC_BASE_MS = 30_000;
const INTEGRATION_SYNC_MAX_BACKOFF_MS = 15 * 60_000;

export function integrationSyncBackoffMs(attempts: number): number {
  return Math.min(INTEGRATION_SYNC_BASE_MS * 2 ** (attempts - 1), INTEGRATION_SYNC_MAX_BACKOFF_MS);
}

const OfflineEmpty = (): unknown => null;

export interface EnqueueOptions {
  runAt?: Date;
  priority?: number;
  maxAttempts?: number;
  /**
   * Idempotency key. A unique index on this column means a job that carries the
   * same key is only ever enqueued once, so a re-run of the producer (cron
   * overlap, manual retry) cannot produce duplicate work.
   */
  digestKey?: string;
}

export class QueueError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
  }
}

/**
 * Enqueue a background job that is processed by `processDueJobs`.
 * Production deployments schedule POST /api/internal/process-queue on a timer.
 */
export async function enqueueJob(
  type: JobType | string,
  payload: Record<string, unknown>,
  opts: EnqueueOptions = {},
): Promise<void> {
  try {
    await db.insert(backgroundJobs).values({
      type,
      payload,
      runAt: opts.runAt ?? new Date(),
      priority: opts.priority ?? 5,
      maxAttempts: opts.maxAttempts ?? 3,
      digestKey: opts.digestKey ?? null,
    });
    // best-effort opportunistic processing (bounded)
    void processDueJobs(0.15).catch(() => OfflineEmpty);
  } catch {
    // queue is best-effort; never fail the primary operation
  }
}

/**
 * Enqueue a job that must not be duplicated, and report whether it was.
 *
 * `enqueueJob` deliberately swallows every error, which is right for its
 * callers but hides the one error that matters for a digest: a unique-violation
 * on `digestKey` means another scan already queued this window. Producers that
 * report progress need that distinction, so this uses `ON CONFLICT DO NOTHING`
 * against the digest index and returns `true` only when a row really landed.
 */
export type EnqueueOutcome =
  /** Row inserted. A handler will pick this up. */
  | { status: 'queued'; id: string }
  /**
   * The digest key already exists, so an equivalent job is pending or done.
   *
   * This is a success for dedupe purposes, and a distinct case from `failed`:
   * the page is already in flight and must not be re-queued.
   */
  | { status: 'duplicate' }
  /** The insert threw. Nothing was queued and the work never happened. */
  | { status: 'failed'; error: unknown };

/**
 * Enqueue with the reason for a non-insert exposed.
 *
 * `enqueueJobOnce` collapses `duplicate` and `failed` into a single `false`,
 * which is fine when the caller only wants "should I count a notification as
 * sent" but wrong for a caller that has to react to the difference - one means
 * the work is done, the other means it is still owed. This is the
 * non-collapsing form; `enqueueJobOnce` wraps it so existing callers are
 * unaffected.
 */
export async function enqueueJobOnceDetailed(
  type: JobType | string,
  payload: Record<string, unknown>,
  opts: EnqueueOptions & { digestKey: string },
): Promise<EnqueueOutcome> {
  try {
    const inserted = await db
      .insert(backgroundJobs)
      .values({
        type,
        payload,
        runAt: opts.runAt ?? new Date(),
        priority: opts.priority ?? 5,
        maxAttempts: opts.maxAttempts ?? 3,
        digestKey: opts.digestKey,
      })
      .onConflictDoNothing({ target: backgroundJobs.digestKey })
      .returning({ id: backgroundJobs.id });

    if (Array.isArray(inserted) && inserted.length > 0) {
      // best-effort opportunistic processing (bounded)
      void processDueJobs(0.15).catch(() => OfflineEmpty);
      return { status: 'queued', id: inserted[0].id };
    }
    return { status: 'duplicate' };
  } catch (error) {
    // queue is best-effort; a failed insert simply did not queue anything
    return { status: 'failed', error };
  }
}

/**
 * Thin boolean wrapper over {@link enqueueJobOnceDetailed}.
 *
 * `false` means "do not count this as sent", which deliberately covers both
 * `duplicate` and `failed`: a lost insert race is not a delivered notification,
 * and neither is one that never got queued.
 */
export async function enqueueJobOnce(
  type: JobType | string,
  payload: Record<string, unknown>,
  opts: EnqueueOptions & { digestKey: string },
): Promise<boolean> {
  return (await enqueueJobOnceDetailed(type, payload, opts)).status === 'queued';
}

export interface JobHandler {
  (payload: Record<string, unknown>): Promise<void>;
}
const handlers = new Map<JobType, JobHandler>();

/** Register a handler for a job type. */
export function registerJobHandler(type: JobType, handler: JobHandler): void {
  handlers.set(type, handler);
}

function withRetry(fn: () => Promise<void>, attempts: number): Promise<void> {
  return fn().catch((err) => {
    if (attempts <= 1) throw err;
    return withRetry(fn, attempts - 1);
  });
}

export async function setTimeoutAsync<T>(
  fn: () => Promise<T>,
  ms: number,
): Promise<T> {
  await new Promise((r) => setTimeout(r, ms));
  return fn();
}

/**
 * Process a bounded number of due jobs. Returns count processed.
 */
export async function processDueJobs(maxJobs = 20): Promise<number> {
  const jobs = await db
    .select()
    .from(backgroundJobs)
    .where(and(eq(backgroundJobs.status, 'PENDING'), lte(backgroundJobs.runAt, new Date())))
    .orderBy(asc(backgroundJobs.priority), asc(backgroundJobs.createdAt))
    .limit(maxJobs);

  let processed = 0;
  for (const job of jobs) {
    const handler = handlers.get(job.type as JobType);
    if (!handler) continue;
    await db
      .update(backgroundJobs)
      .set({ status: 'PROCESSING', attempts: job.attempts + 1, updatedAt: new Date() })
      .where(eq(backgroundJobs.id, job.id));

    try {
      // Only the *remaining* attempt budget is spent in this drain. Retrying
      // the full maxAttempts here would let a job run maxAttempts times per
      // pass, so a job that has already failed twice still got three more
      // tries and the cap in the catch block below never meant what it says.
      const remaining = Math.max(1, job.maxAttempts - job.attempts);
      await withRetry(() => handler(job.payload), remaining);
      await db
        .update(backgroundJobs)
        .set({ status: 'DONE', processedAt: new Date(), updatedAt: new Date() })
        .where(eq(backgroundJobs.id, job.id));
      processed += 1;
    } catch (err) {
      const attempts = job.attempts + 1;
      const failed = attempts >= job.maxAttempts;
      const backoffMs = job.type === 'INTEGRATION_SYNC' ? integrationSyncBackoffMs(attempts) : 0;
      await db
        .update(backgroundJobs)
        .set({
          status: failed ? 'FAILED' : 'PENDING',
          lastError: err instanceof Error ? err.message : String(err),
          attempts,
          ...(backoffMs > 0 ? { runAt: new Date(Date.now() + backoffMs) } : {}),
          updatedAt: new Date(),
        })
        .where(eq(backgroundJobs.id, job.id));
    }
  }
  return processed;
}