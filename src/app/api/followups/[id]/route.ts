import { withApi, param } from '@/lib/handlers';
import { updateFollowup, deleteFollowup, completeFollowup } from '@/lib/services/followups';
import { requirePermission } from '@/lib/api';
import { readJson } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PATCH = withApi(async (actor, req, ctx) => {
  requirePermission(actor.user, 'followups.manage');
  const body = await readJson(req);
  const followup = await updateFollowup(actor, await param(ctx, 'id'), body);
  return followup ?? { status: 404, error: { message: 'Follow-up not found' } };
});

export const DELETE = withApi(async (actor, _req, ctx) => {
  requirePermission(actor.user, 'followups.manage');
  await deleteFollowup(actor, await param(ctx, 'id'));
});

export const POST = withApi(async (actor, req, ctx) => {
  requirePermission(actor.user, 'followups.manage');
  const body = await readJson(req);
  const result = await completeFollowup(actor, await param(ctx, 'id'), body);
  return { ...result, ok: true };
});