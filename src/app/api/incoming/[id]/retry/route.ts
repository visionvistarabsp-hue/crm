import { withApi, param } from '@/lib/handlers';
import { requirePermission } from '@/lib/api';
import { retryIncomingReceipt } from '@/lib/services/incomingLeadSync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Operator action: hand a stuck receipt back to the queue. Only RECEIVED
 * receipts are retried (a terminal receipt already resolved); an exhausted
 * receipt revives its FAILED job, an orphaned one gets a fresh digest-deduped
 * job.
 */
export const POST = withApi(async (actor, req, ctx) => {
  requirePermission(actor.user, 'settings.manage');
  const id = await param(ctx, 'id');
  const result = await retryIncomingReceipt(id);
  if (!result.ok) return { error: { message: result.error ?? 'retry failed' }, status: 404 };
  return { ok: true, id, retried: result.retried, reused: result.reused ?? false, status: result.status };
});