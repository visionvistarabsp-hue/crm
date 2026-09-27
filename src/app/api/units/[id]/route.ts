import { withApi, param } from '@/lib/handlers';
import { updateUnit, holdUnit, releaseUnitHold } from '@/lib/services/projects';
import { requirePermission } from '@/lib/api';
import { readJson } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PATCH = withApi(async (actor, req, ctx) => {
  requirePermission(actor.user, 'units.manage');
  const body = await readJson(req);
  const unit = await updateUnit(actor, await param(ctx, 'id'), body);
  return unit ?? { status: 404, error: { message: 'Unit not found' } };
});

export const POST = withApi(async (actor, req, ctx) => {
  requirePermission(actor.user, 'units.manage');
  const body: any = await readJson(req);
  const id = await param(ctx, 'id');
  if (body.action === 'hold' && body.holdUntil) {
    return { unit: await holdUnit(actor, id, new Date(body.holdUntil)), ok: true };
  }
  if (body.action === 'release') {
    return { unit: await releaseUnitHold(actor, id), ok: true };
  }
  return { status: 400, error: { message: 'Unknown action' } };
});