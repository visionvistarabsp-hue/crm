import { withApi } from '@/lib/handlers';
import { listCancellations } from '@/lib/services/bookings';
import { requirePermission } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApi(async (actor, req) => {
  requirePermission(actor.user, 'cancellations.approve');
  const rows = await listCancellations(actor, req.nextUrl.searchParams.get('status') ?? undefined);
  return { items: rows };
});