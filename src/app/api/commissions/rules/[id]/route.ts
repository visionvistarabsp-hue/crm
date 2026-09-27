import { withApi, param } from '@/lib/handlers';
import { updateCommissionRule } from '@/lib/services/commissions';
import { requirePermission } from '@/lib/api';
import { readJson } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PATCH = withApi(async (actor, req, ctx) => {
  requirePermission(actor.user, 'commissions.manage');
  const body = await readJson(req);
  const rule = await updateCommissionRule(actor, await param(ctx, 'id'), body);
  return { rule, ok: true };
});