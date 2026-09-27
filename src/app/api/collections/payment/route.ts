import { readJson, requirePermission } from '@/lib/api';
import { withApi } from '@/lib/handlers';
import { recordPayment } from '@/lib/services/collections';
import { milestonePaymentSchema } from '@/lib/validators';

/**
 * Record a payment against a booking and allocate it to the instalment plan.
 * Allocation defaults to oldest-due-first; passing a milestoneId pins the money
 * to that one row instead.
 */
export const POST = withApi(async (actor, req) => {
  requirePermission(actor.user, 'collections.manage');
  const body = milestonePaymentSchema.parse(await readJson(req));

  return recordPayment(actor, {
    bookingId: body.bookingId,
    amount: body.amount,
    method: body.method,
    reference: body.reference ?? null,
    paymentDate: body.paymentDate ?? undefined,
    // An explicit milestone always wins over auto-allocation.
    milestoneId: body.milestoneId ?? null,
  });
});
