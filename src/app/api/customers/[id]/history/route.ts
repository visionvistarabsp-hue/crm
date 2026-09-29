import { withApi, param } from '@/lib/handlers';
import { requirePermission, readJson } from '@/lib/api';
import { getCustomer360, addCustomerActivity } from '@/lib/services/customerHistory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApi(async (actor, _req, ctx) => {
  requirePermission(actor.user, 'customers.view');
  return getCustomer360(actor, await param(ctx, 'id'));
});

/** Append a note to the customer's history. */
export const POST = withApi(async (actor, req, ctx) => {
  requirePermission(actor.user, 'customers.update');
  return addCustomerActivity(actor, await param(ctx, 'id'), await readJson(req));
});
