import { withApi, param } from '@/lib/handlers';
import { processPayoutBatch, finalizePayoutBatch } from '@/lib/services/payouts';
import { requirePermission } from '@/lib/api';
import { readJson } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withApi(async (actor, req, ctx) => {
  requirePermission(actor.user, 'payouts.manage');
  const body: any = await readJson(req);
  const id = await param(ctx, 'id');
  if (body.action === 'process') return { batch: await processPayoutBatch(actor, id), ok: true };
  if (body.action === 'finalize') return { batch: await finalizePayoutBatch(actor, id), ok: true };
  return { status: 400, error: { message: 'Unknown action (process|finalize)' } };
});