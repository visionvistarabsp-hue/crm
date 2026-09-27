import { db } from './db';
import { backgroundJobs } from './db/schema';
import { and, lt, lte, eq, asc } from 'drizzle-orm';

export type JobType = 'NOTIFY' | 'REMINDER' | 'AUTOMATION' | 'EMAIL' | 'WHATSAPP' | 'INTEGRATION_SYNC';

const OfflineEmpty = (): unknown => null;

export interface EnqueueOptions {
  runAt?: Date;
  priority?: number;
  maxAttempts?: number;
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
    });
    // best-effort opportunistic processing (bounded)
    void processDueJobs(0.15).catch(() => OfflineEmpty);
  } catch {
    // queue is best-effort; never fail the primary operation
  }
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
      await withRetry(() => handler(job.payload), job.maxAttempts);
      await db
        .update(backgroundJobs)
        .set({ status: 'DONE', processedAt: new Date(), updatedAt: new Date() })
        .where(eq(backgroundJobs.id, job.id));
      processed += 1;
    } catch (err) {
      const attempts = job.attempts + 1;
      const failed = attempts >= job.maxAttempts;
      await db
        .update(backgroundJobs)
        .set({
          status: failed ? 'FAILED' : 'PENDING',
          lastError: err instanceof Error ? err.message : String(err),
          attempts,
          updatedAt: new Date(),
        })
        .where(eq(backgroundJobs.id, job.id));
    }
  }
  return processed;
}