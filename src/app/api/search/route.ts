import { withApi } from '@/lib/handlers';
import { globalSearch, searchUnits } from '@/lib/services/search';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApi(async (actor, req) => {
  const sp = req.nextUrl.searchParams;
  const term = sp.get('q') ?? '';
  const scope = sp.get('scope') ?? 'all';
  if (scope === 'units') {
    return { units: await searchUnits(actor, term, sp.get('projectId') ?? undefined) };
  }
  const all = await globalSearch(actor, term, Number(sp.get('limit') ?? 5));
  if (scope !== 'all') return { [scope]: all[scope as keyof typeof all] ?? [] };
  return all;
});