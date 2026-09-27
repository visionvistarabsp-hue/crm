import { withApi } from '@/lib/handlers';
import { listCustomers, createCustomer } from '@/lib/services/customers';
import { requirePermission, pagination } from '@/lib/api';
import { readJson } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApi(async (actor, req) => {
  requirePermission(actor.user, 'customers.view');
  const sp = req.nextUrl.searchParams;
  const { page, pageSize } = pagination(sp);
  const result = await listCustomers(actor, {
    search: sp.get('q') ?? undefined,
    ownerId: sp.get('ownerId') ?? undefined,
    page,
    pageSize,
  });
  return { ...result, page, pageSize };
});

export const POST = withApi(async (actor, req) => {
  requirePermission(actor.user, 'customers.create');
  const body = await readJson(req);
  const customer = await createCustomer(actor, body);
  return { customer, ok: true };
});