import { requirePermission } from '@/lib/api';
import { withApi } from '@/lib/handlers';
import { listEasyLeads } from '@/lib/services/easy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApi(async (actor, req) => {
  requirePermission(actor.user, 'leads.view');
  const sp = req.nextUrl.searchParams;
  const items = await listEasyLeads(actor, {
    search: sp.get('q') ?? undefined,
    limit: sp.get('limit') ? Number(sp.get('limit')) : undefined,
  });
  return { items };
});
