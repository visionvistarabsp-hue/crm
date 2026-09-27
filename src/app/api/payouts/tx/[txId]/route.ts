import { withApi, param } from '@/lib/handlers';
import { reversePayoutTx } from '@/lib/services/payouts';
import { requirePermission } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withApi(async (actor, _req, ctx) => {
  requirePermission(actor.user, 'payouts.manage');
  await reversePayoutTx(actor, await param(ctx, 'id'));
  return { ok: true };
});