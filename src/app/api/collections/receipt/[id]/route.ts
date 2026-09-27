import { requirePermission } from '@/lib/api';
import { param, withApi } from '@/lib/handlers';
import { getReceipt, issueReceipt, voidReceipt } from '@/lib/services/collections';
import { receiptVoidSchema } from '@/lib/validators';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Printable receipt for one payment. */
export const GET = withApi(async (actor, _req, ctx) => {
  requirePermission(actor.user, 'collections.view');
  return getReceipt(actor, await param(ctx, 'id'));
});

/** Issue (or reissue) the receipt for a payment. */
export const POST = withApi(async (actor, _req, ctx) => {
  requirePermission(actor.user, 'receipts.issue');
  return issueReceipt(actor, await param(ctx, 'id'));
});

/**
 * Void a receipt. The payment and the money it represents are untouched - a
 * void receipt is a paperwork event, not a refund.
 */
export const DELETE = withApi(async (actor, req, ctx) => {
  requirePermission(actor.user, 'receipts.issue');
  const { reason } = receiptVoidSchema.parse(await req.json());
  await voidReceipt(actor, await param(ctx, 'id'), reason);
  return { ok: true };
});
