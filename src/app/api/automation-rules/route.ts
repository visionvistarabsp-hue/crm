import { withApi } from '@/lib/handlers';
import { listAutomationRules, createAutomationRule } from '@/lib/services/automation';
import { requirePermission } from '@/lib/api';
import { readJson } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApi(async (actor) => {
  requirePermission(actor.user, 'settings.manage');
  return { items: await listAutomationRules() };
});

export const POST = withApi(async (actor, req) => {
  requirePermission(actor.user, 'settings.manage');
  const body = await readJson(req);
  const rule = await createAutomationRule(actor, body);
  return { rule, ok: true };
});