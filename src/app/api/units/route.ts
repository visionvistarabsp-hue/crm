import { withApi } from '@/lib/handlers';
import { listUnits, createUnit } from '@/lib/services/projects';
import { requirePermission, pagination } from '@/lib/api';
import { readJson } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApi(async (actor, req) => {
  requirePermission(actor.user, 'projects.manage');
  const sp = req.nextUrl.searchParams;
  const { page, pageSize } = pagination(sp);
  const result = await listUnits(actor, {
    projectId: sp.get('projectId') ?? undefined,
    towerId: sp.get('towerId') ?? undefined,
    status: sp.get('status') ?? undefined,
    bhk: sp.get('bhk') ?? undefined,
    search: sp.get('q') ?? undefined,
    page,
    pageSize,
  });
  return { ...result, page, pageSize };
});

export const POST = withApi(async (actor, req) => {
  requirePermission(actor.user, 'units.manage');
  const body = await readJson(req);
  const unit = await createUnit(actor, body);
  return { unit, ok: true };
});