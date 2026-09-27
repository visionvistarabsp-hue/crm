import { withApi } from '@/lib/handlers';
import { createRefund } from '@/lib/services/bookings';
import { requirePermission } from '@/lib/api';
import { readJson } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withApi(async (actor, req) => {
  requirePermission(actor.user, 'bookings.cancel');
  const body = await readJson(req);
  const refund = await createRefund(actor, body);
  return { refund, ok: true };
});