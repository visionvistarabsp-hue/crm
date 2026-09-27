import { withApi } from '@/lib/handlers';
import { listBookings, createBooking } from '@/lib/services/bookings';
import { requirePermission, pagination } from '@/lib/api';
import { readJson } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApi(async (actor, req) => {
  requirePermission(actor.user, 'bookings.view');
  const sp = req.nextUrl.searchParams;
  const { page, pageSize } = pagination(sp);
  const result = await listBookings(actor, {
    status: sp.get('status') ?? undefined,
    projectId: sp.get('projectId') ?? undefined,
    salespersonId: sp.get('salespersonId') ?? undefined,
    customerId: sp.get('customerId') ?? undefined,
    from: sp.get('from') ?? undefined,
    to: sp.get('to') ?? undefined,
    search: sp.get('q') ?? undefined,
    page,
    pageSize,
  });
  return { ...result, page, pageSize };
});

export const POST = withApi(async (actor, req) => {
  requirePermission(actor.user, 'bookings.manage');
  const body = await readJson(req);
  const booking = await createBooking(actor, body);
  return { booking, ok: true };
});