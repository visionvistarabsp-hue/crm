import { withApi } from '@/lib/handlers';
import { requirePermission } from '@/lib/api';
import { getCancellationReport } from '@/lib/services/analytics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApi(async (actor, req) => {
  requirePermission(actor.user, 'reports.view');
  const sp = req.nextUrl.searchParams;
  return await getCancellationReport(actor, {
    projectId: sp.get('projectId') ?? undefined,
    from: sp.get('from') ?? undefined,
    to: sp.get('to') ?? undefined,
  });
});
