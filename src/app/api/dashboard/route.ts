import { withApi } from '@/lib/handlers';
import { getDashboard } from '@/lib/services/analytics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApi(async (actor, req) => {
  const sp = req.nextUrl.searchParams;
  return await getDashboard(actor, {
    projectId: sp.get('projectId') ?? undefined,
    from: sp.get('from') ?? undefined,
    to: sp.get('to') ?? undefined,
  });
});