import { withApi, param } from '@/lib/handlers';
import { requestCancellation } from '@/lib/services/bookings';
import { requirePermission } from '@/lib/api';
import { readJson } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withApi(async (actor, req, ctx) => {
  requirePermission(actor.user, 'bookings.cancel');
  const body = await readJson(req);
  const cancellation = await requestCancellation(actor, await param(ctx, 'id'), body);
  return { cancellation, ok: true };
});