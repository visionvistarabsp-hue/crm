import { withApi, param } from '@/lib/handlers';
import { updateAutomationRule, deleteAutomationRule, listAutomationRules } from '@/lib/services/automation';
import { requirePermission } from '@/lib/api';
import { readJson } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PATCH = withApi(async (actor, req, ctx) => {
  requirePermission(actor.user, 'settings.manage');
  const body = await readJson(req);
  const rule = await updateAutomationRule(actor, await param(ctx, 'id'), body);
  return rule ?? { status: 404, error: { message: 'Rule not found' } };
});

export const POST = withApi(async (actor, _req, ctx) => {
  requirePermission(actor.user, 'settings.manage');
  const id = await param(ctx, 'id');
  const rules = await listAutomationRules();
  const current = rules.find((r) => r.id === id);
  if (!current) return { status: 404, error: { message: 'Rule not found' } };
  const rule = await updateAutomationRule(actor, id, { isActive: !current.isActive });
  return rule ?? { status: 404, error: { message: 'Rule not found' } };
});

export const DELETE = withApi(async (actor, _req, ctx) => {
  requirePermission(actor.user, 'settings.manage');
  await deleteAutomationRule(actor, await param(ctx, 'id'));
});