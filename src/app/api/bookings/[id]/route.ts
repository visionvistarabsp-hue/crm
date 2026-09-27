import { withApi, param } from '@/lib/handlers';
import { getBooking, updateBooking, createPayment } from '@/lib/services/bookings';
import { readJson } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApi(async (actor, _req, ctx) => {
  const booking = await getBooking(actor, await param(ctx, 'id'));
  return booking ?? { status: 404, error: { message: 'Booking not found' } };
});

export const PATCH = withApi(async (actor, req, ctx) => {
  const body = await readJson(req);
  const booking = await updateBooking(actor, await param(ctx, 'id'), body);
  return booking ?? { status: 404, error: { message: 'Booking not found' } };
});

export const POST = withApi(async (actor, req, ctx) => {
  const body = await readJson(req);
  const payment = await createPayment(actor, await param(ctx, 'id'), body);
  return { payment, ok: true };
});