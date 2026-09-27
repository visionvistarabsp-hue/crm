import { withApi, param } from '@/lib/handlers';
import { getPersonCommissionSummary } from '@/lib/services/commissions';
import { requirePermission } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApi(async (actor, _req, ctx) => {
  requirePermission(actor.user, 'commissions.manage');
  return await getPersonCommissionSummary(await param(ctx, 'id'));
});