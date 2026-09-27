import { withApi } from '@/lib/handlers';
import { listCommissionRules, createCommissionRule, getCommissionDashboard } from '@/lib/services/commissions';
import { requirePermission } from '@/lib/api';
import { readJson } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApi(async (actor) => {
  requirePermission(actor.user, 'commissions.manage');
  const rules = await listCommissionRules();
  return { items: rules };
});

export const POST = withApi(async (actor, req) => {
  requirePermission(actor.user, 'commissions.manage');
  const body = await readJson(req);
  const rule = await createCommissionRule(actor, body);
  return { rule, ok: true };
});