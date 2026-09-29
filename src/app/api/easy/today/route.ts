import { requirePermission } from '@/lib/api';
import { withApi } from '@/lib/handlers';
import { listEasyDues, listEasyFollowups } from '@/lib/services/easy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApi(async (actor) => {
  requirePermission(actor.user, 'leads.view');
  const [followups, dues] = await Promise.all([listEasyFollowups(actor), listEasyDues(actor)]);
  return { followups, dues, total: followups.length + dues.length };
});
