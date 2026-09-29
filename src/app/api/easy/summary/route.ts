import { requirePermission } from '@/lib/api';
import { withApi } from '@/lib/handlers';
import { getEasySummary } from '@/lib/services/easy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApi(async (actor) => {
  requirePermission(actor.user, 'leads.view');
  return getEasySummary(actor);
});
