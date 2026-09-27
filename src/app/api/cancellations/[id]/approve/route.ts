import { withApi, param } from '@/lib/handlers';
import { approveCancellation } from '@/lib/services/bookings';
import { requirePermission } from '@/lib/api';
import { readJson } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withApi(async (actor, req, ctx) => {
  requirePermission(actor.user, 'cancellations.approve');
  const body = await readJson(req);
  const result = await approveCancellation(actor, await param(ctx, 'id'), body);
  return { ...result, ok: true };
});