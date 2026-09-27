import { withApi } from '@/lib/handlers';
import { listPayoutBatches, createPayoutBatch } from '@/lib/services/payouts';
import { requirePermission } from '@/lib/api';
import { readJson } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApi(async (actor) => {
  requirePermission(actor.user, 'payouts.manage');
  const batches = await listPayoutBatches();
  return { items: batches };
});

export const POST = withApi(async (actor, req) => {
  requirePermission(actor.user, 'payouts.manage');
  const body = await readJson(req);
  const batch = await createPayoutBatch(actor, body);
  return { batch, ok: true };
});