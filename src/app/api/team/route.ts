import { withApi } from '@/lib/handlers';
import { listTeam } from '@/lib/services/users';
import { requirePermission } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApi(async (actor) => {
  requirePermission(actor.user, 'team.manage');
  const items = await listTeam();
  return { items };
});