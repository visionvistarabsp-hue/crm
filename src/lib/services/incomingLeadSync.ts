import { and, asc, eq, lte } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db';
import { backgroundJobs, incomingLeads, type IncomingLead } from '@/lib/db/schema';
import { registerJobHandler, enqueueJobOnceDetailed } from '@/lib/queue';
import { createLead } from '@/lib/services/leads';
import { webhookLeadSchema } from '@/lib/validators';
import { type CurrentUser } from '@/lib/auth';
import { type Actor } from '@/lib/api';

/**
 * Durable sync of provider webhook receipts.
 *
 * The webhook path is synchronous: insert a RECEIVED receipt, then create the
 * lead in the same request. The only failure mode that used to matter was a
 * delivery that hit the provider 500 path - the receipt was marked ERROR and
 * the provider was asked to retry.
 *
 * That assumption broke on transient failures (a dead DB pool for a moment, an
 * assignment pool momentarily empty): the receipt was burned to ERROR even
 * though the payload was fine and a retry seconds later would have succeeded.
 * So when lead creation fails the receipt now stays RECEIVED (still the audit
 * trail of an in-flight delivery) and an INTEGRATION_SYNC job is enqueued with
 * a digest key tied to the receipt. The queue retries with a bounded
 * exponential backoff; the first attempt that succeeds lands CREATED/DUPLICATE,
 * and if every attempt fails the job goes FAILED while the receipt keeps its
 * RECEIVED status so a reconciliation scan can find it again.
 *
 * Every status write below is scoped to the receipt in question - a writer that
 * forgets the `.where(...)` would silently rewrite every other provider's
 * receipt, which is exactly the bug that stranded the stuck MAGICBRICKS rows.
 */

export const INTEGRATION_SYNC_MAX_ATTEMPTS = 4;

export type IncomingApplyResult = {
  leadId: string;
  leadNo: string;
  duplicates: number;
  created: boolean;
};

const TERMINAL = new Set(['CREATED', 'DUPLICATE', 'ERROR', 'IGNORED']);

/** Only the durable part of the actor belongs in a persisted job payload. */
function actorToUser(actor: unknown): CurrentUser | undefined {
  if (!actor || typeof actor !== 'object') return undefined;
  const a = actor as { user?: CurrentUser } | null;
  return a?.user ?? (actor as CurrentUser);
}

/**
 * Provider-side stable ids disagree on the field name: payloads send `lead_id`
 * (e.g. ext_794887) while the app's dedup key is `sourceRef`. Alias it before
 * validation, otherwise a redelivery of the same provider lead would quietly
 * create a brand-new lead. The original delivery stays in raw_payload for audit.
 */
export function aliasSourceRef(raw: Record<string, unknown>): Record<string, unknown> {
  return { ...raw, sourceRef: raw.sourceRef ?? raw.lead_id };
}

/**
 * Shared verdict step for both the webhook path and the queue retry: create the
 * lead from parsed data and terminalize its receipt (CREATED or DUPLICATE).
 *
 * Throws on failure and writes nothing - the caller decides whether that is a
 * permanent ERROR or a retryable queue failure.
 */
export async function applyIncomingLead(
  actor: Actor,
  incoming: Pick<IncomingLead, 'id' | 'provider'>,
  data: z.infer<typeof webhookLeadSchema>,
  rawPayload: Record<string, unknown>,
): Promise<IncomingApplyResult> {
  const result = await createLead(actor, {
    name: data.name,
    phone: data.phone,
    whatsapp: data.whatsapp,
    email: data.email,
    campaign: data.campaign,
    adName: data.adName,
    projectId: data.project as string | undefined,
    budget: data.budget,
    preferredLocation: data.preferredLocation,
    propertyType: data.propertyType,
    requirement: data.requirement,
    sourceRef: data.sourceRef,
    // Providers that have no channel of their own (site forms, listing portals)
    // are website leads; the sender can override with any known source.
    source: data.source ?? 'WEBSITE',
    notes: `Imported via ${incoming.provider} webhook`,
    meta: { raw: data.raw },
  });

  await db
    .update(incomingLeads)
    .set(
      result.created
        ? { status: 'CREATED', leadId: result.lead.id, normalized: rawPayload }
        : { status: 'DUPLICATE', leadId: result.lead.id, normalized: rawPayload },
    )
    .where(eq(incomingLeads.id, incoming.id));

  return {
    leadId: result.lead.id,
    leadNo: result.lead.leadNo,
    duplicates: result.duplicates.length,
    created: result.created,
  };
}

/**
 * Enqueue the retry for a receipt whose first synchronous attempt failed.
 *
 * The digest key is the receipt id, so a provider redelivery of the body (which
 * creates a brand-new receipt) can never double-queue the same one. Best-effort
 * by design: the queue swallows its own errors.
 */
export function syncRetryDigestKey(incomingId: string): string {
  return `integration:${incomingId}`;
}

export async function enqueueSyncRetry(
  incomingId: string,
  actor: unknown,
): Promise<void> {
  const user = actorToUser(actor);
  await enqueueJobOnceDetailed(
    'INTEGRATION_SYNC',
    { incomingId, ...(user ? { actor: user } : {}) },
    {
      digestKey: syncRetryDigestKey(incomingId),
      maxAttempts: INTEGRATION_SYNC_MAX_ATTEMPTS,
      runAt: new Date(),
    },
  );
}

/**
 * The queue-side retry job. Picks the RECEIVED receipt back up and runs the
 * same verdict as the webhook path.
 *
 * Idempotent: a receipt that has already reached a terminal status (including
 * one terminalized by a *previous* drain that then errored after the fact) is a
 * no-op, so a replayed or overlapping job cannot create a second lead.
 */
export async function handleIntegrationSync(payload: Record<string, unknown>): Promise<void> {
  const incomingId = String(payload.incomingId ?? '');
  if (!incomingId) return;

  const rows = await db
    .select()
    .from(incomingLeads)
    .where(eq(incomingLeads.id, incomingId))
    .limit(1);
  const incoming = rows[0];
  // The receipt is gone (manual cleanup): nothing left to sync.
  if (!incoming) return;
  // Already resolved by an earlier attempt, a duplicate path, or a permanent
  // ERROR: nothing left to do. Leaving the status untouched is what makes a
  // stale replay safe.
  if (TERMINAL.has(incoming.status)) return;

  const user = actorToUser(payload.actor);
  const actor = {
    user: user ?? { id: 'system', name: 'System', email: 'system@salespoint.in', role: 'SALES_EXECUTIVE' as const, permissions: [], isSuperAdmin: false },
    ip: null,
    userAgent: null,
    path: 'queue:INTEGRATION_SYNC',
    method: 'WORKER',
  } as Actor;

  // raw_payload is the original body, so the `lead_id` -> sourceRef alias is
  // re-applied exactly like the webhook path does before validation.
  const normalized = aliasSourceRef(incoming.rawPayload);
  const parsed = webhookLeadSchema.safeParse(normalized);

  if (!parsed.success) {
    // A payload that fails validation can never succeed, so this is a terminal
    // receipt state, not a retryable failure: mark ERROR and let the job finish.
    await db
      .update(incomingLeads)
      .set({ status: 'ERROR', error: parsed.error.message })
      .where(eq(incomingLeads.id, incoming.id));
    return;
  }

  // A transient failure (DB blip, empty assignment pool) surfaces as a throw so
  // the queue can retry with backoff. Only after the last attempt does the job
  // go FAILED, while the receipt stays RECEIVED for the reconciliation scan.
  await applyIncomingLead(actor, incoming, parsed.data, incoming.rawPayload);
}

/** Register the job handler, next to the only place the queue is drained. */
export function registerIntegrationSyncHandler(): void {
  registerJobHandler('INTEGRATION_SYNC', (payload) => handleIntegrationSync(payload));
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * A receipt is only reconciliable after every retry path has had its chance:
 * the webhook attempt plus four queue attempts land within ~8 minutes of the
 * original delivery, and a queue that is down for longer than the worst-case
 * backoff still owes the receipt a run rather than a tombstone. 30 minutes is
 * the line between "a retry is still in flight" and "the queue gave up".
 */
export const RECONCILE_STALE_MS = 30 * 60_000;

/** Bound the work a single cron tick can do; leftovers wait for the next tick. */
export const RECONCILE_MAX_SCAN = 200;

export type IncomingScanResult = {
  /** Stale RECEIVED receipts examined this tick. */
  scanned: number;
  /** Marked ERROR because every queue attempt failed. */
  exhausted: number;
  /** Re-enqueued for a fresh run (no job row existed). */
  requeued: number;
  /** A job for the receipt already exists (retry in flight or done); left alone. */
  alreadyRetrying: number;
  /** The enqueue insert threw; the receipt is left RECEIVED for next tick. */
  enqueueFailed: number;
};

/**
 * Sweep receipts stuck in RECEIVED past the staleness window.
 *
 * Two ways a receipt can be stranded, and each gets exactly one resolution:
 *
 *  - The queue burned all INTEGRATION_SYNC attempts (a FAILED job row carries
 *    the receipt's digest key): the payload could not be applied in the window,
 *    so the receipt is terminalized ERROR with the job's last error - never
 *    retried forever by this scan.
 *  - No job row exists at all (a provider redelivery that landed before the
 *    worker shipped, an enqueue that silently failed): the retry is re-enqueued.
 *    The digest key dedupes against any job already in flight, so an
 *    overlapping scan cannot queue duplicate work.
 *
 * Safe to run on every cron tick: once terminalized a receipt drops out of the
 * scan, and re-enqueue is idempotent per receipt.
 */
export async function scanIncomingLeads(reference: Date = new Date()): Promise<IncomingScanResult> {
  const result: IncomingScanResult = {
    scanned: 0,
    exhausted: 0,
    requeued: 0,
    alreadyRetrying: 0,
    enqueueFailed: 0,
  };
  const cutoff = new Date(reference.getTime() - RECONCILE_STALE_MS);

  const stuck = await db
    .select()
    .from(incomingLeads)
    .where(and(eq(incomingLeads.status, 'RECEIVED'), lte(incomingLeads.receivedAt, cutoff)))
    .orderBy(asc(incomingLeads.receivedAt))
    .limit(RECONCILE_MAX_SCAN);

  for (const incoming of stuck) {
    result.scanned += 1;
    const key = syncRetryDigestKey(incoming.id);

    const failedJob = await db
      .select({ lastError: backgroundJobs.lastError })
      .from(backgroundJobs)
      .where(and(eq(backgroundJobs.digestKey, key), eq(backgroundJobs.status, 'FAILED')))
      .limit(1);

    if (failedJob[0]) {
      // Every queue attempt failed: this receipt will never sync on retry, so
      // leave an auditable ERROR instead of letting the scan pound on it.
      await db
        .update(incomingLeads)
        .set({ status: 'ERROR', error: failedJob[0].lastError ?? 'sync failed after max attempts' })
        .where(eq(incomingLeads.id, incoming.id));
      result.exhausted += 1;
      continue;
    }

    const outcome = await enqueueJobOnceDetailed(
      'INTEGRATION_SYNC',
      { incomingId: incoming.id },
      { digestKey: key, maxAttempts: INTEGRATION_SYNC_MAX_ATTEMPTS, runAt: new Date() },
    );
    if (outcome.status === 'queued') result.requeued += 1;
    else if (outcome.status === 'duplicate') result.alreadyRetrying += 1;
    else result.enqueueFailed += 1;
  }

  return result;
}

export type RetryIncomingOutcome = {
  ok: boolean;
  /** The receipt was handed back to the queue this call. */
  retried: boolean;
  /** True when an existing FAILED job was reset rather than a new row inserted. */
  reused?: boolean;
  status: IncomingLead['status'] | null;
  error?: string;
};

/**
 * Operator action: hand a stuck receipt back to the queue.
 *
 * The receipt must still be RECEIVED - a terminal status means the work already
 * resolved and retrying would just duplicate a lead. For an exhausted receipt
 * whose FAILED job still occupies the digest key, the job itself is revived
 * (status PENDING, attempt budget reset) so the existing retry loop runs again;
 * otherwise a fresh, digest-deduped job is enqueued.
 */
export async function retryIncomingReceipt(id: string): Promise<RetryIncomingOutcome> {
  const rows = await db
    .select()
    .from(incomingLeads)
    .where(eq(incomingLeads.id, id))
    .limit(1);
  const incoming = rows[0];
  if (!incoming) return { ok: false, retried: false, status: null, error: 'receipt not found' };
  if (incoming.status !== 'RECEIVED') {
    return { ok: true, retried: false, status: incoming.status };
  }

  const key = syncRetryDigestKey(incoming.id);
  const revived = await db
    .update(backgroundJobs)
    .set({ status: 'PENDING', attempts: 0, lastError: null, runAt: new Date(), updatedAt: new Date() })
    .where(and(eq(backgroundJobs.digestKey, key), eq(backgroundJobs.status, 'FAILED')))
    .returning({ id: backgroundJobs.id });

  if (revived.length > 0) {
    return { ok: true, retried: true, reused: true, status: incoming.status };
  }

  const outcome = await enqueueJobOnceDetailed(
    'INTEGRATION_SYNC',
    { incomingId: incoming.id },
    { digestKey: key, maxAttempts: INTEGRATION_SYNC_MAX_ATTEMPTS, runAt: new Date() },
  );
  if (outcome.status === 'queued') {
    return { ok: true, retried: true, reused: false, status: incoming.status };
  }
  if (outcome.status === 'duplicate') {
    return { ok: true, retried: false, status: incoming.status };
  }
  return {
    ok: false,
    retried: false,
    status: incoming.status,
    error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
  };
}