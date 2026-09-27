import { ApiError, requirePermission } from '@/lib/api';
import { withApi } from '@/lib/handlers';
import { getSchedule } from '@/lib/services/collections';

/** One booking's instalment plan, as shown on the booking detail page. */
export const GET = withApi(async (actor, req) => {
  requirePermission(actor.user, 'collections.view');
  const bookingId = req.nextUrl.searchParams.get('bookingId');
  if (!bookingId) throw new ApiError(400, 'bookingId is required', 'BAD_REQUEST');
  return getSchedule(actor, bookingId);
});
