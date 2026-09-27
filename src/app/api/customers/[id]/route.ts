import { withApi, param } from '@/lib/handlers';
import { getCustomer, updateCustomer, deleteCustomer } from '@/lib/services/customers';
import { requirePermission } from '@/lib/api';
import { readJson } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApi(async (actor, _req, ctx) => {
  requirePermission(actor.user, 'customers.view');
  const customer = await getCustomer(actor, await param(ctx, 'id'));
  return customer ?? { status: 404, error: { message: 'Customer not found' } };
});

export const PATCH = withApi(async (actor, req, ctx) => {
  requirePermission(actor.user, 'customers.update');
  const body = await readJson(req);
  const customer = await updateCustomer(actor, await param(ctx, 'id'), body);
  return customer ?? { status: 404, error: { message: 'Customer not found' } };
});

export const DELETE = withApi(async (actor, _req, ctx) => {
  requirePermission(actor.user, 'customers.delete');
  await deleteCustomer(actor, await param(ctx, 'id'));
});