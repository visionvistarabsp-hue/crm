import { withApi } from '@/lib/handlers';
import { getCommissionDashboard } from '@/lib/services/commissions';
import { requirePermission } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApi(async (actor) => {
  requirePermission(actor.user, 'commissions.manage');
  return await getCommissionDashboard();
});