import { withApi, param } from '@/lib/handlers';
import { getLeadOperations } from '@/lib/services/leadOperations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApi(async (actor, _req, ctx) => {
  const id = await param(ctx, 'id');
  return await getLeadOperations(actor, id);
});