import { withApi, param } from '@/lib/handlers';
import { getLead, updateLead, deleteLead } from '@/lib/services/leads';
import { requirePermission } from '@/lib/api';
import { readJson } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApi(async (actor, _req, ctx) => {
  requirePermission(actor.user, 'leads.view');
  const lead = await getLead(actor, await param(ctx, 'id'));
  return lead ?? { error: { message: 'Lead not found' }, status: 404 };
});

export const PATCH = withApi(async (actor, req, ctx) => {
  requirePermission(actor.user, 'leads.update');
  const body = await readJson(req);
  const lead = await updateLead(actor, await param(ctx, 'id'), body);
  return lead ?? { error: { message: 'Lead not found' }, status: 404 };
});

export const DELETE = withApi(async (actor, _req, ctx) => {
  requirePermission(actor.user, 'leads.delete');
  await deleteLead(actor, await param(ctx, 'id'));
});