import { withApi } from '@/lib/handlers';
import { getPayoutDashboard } from '@/lib/services/payouts';
import { requirePermission } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApi(async (actor) => {
  requirePermission(actor.user, 'payouts.manage');
  return await getPayoutDashboard();
});