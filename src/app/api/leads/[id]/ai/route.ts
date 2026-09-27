import { withApi, param } from '@/lib/handlers';
import { ApiError, requirePermission } from '@/lib/api';
import { getLead } from '@/lib/services/leads';
import { generateLeadBrief, getLeadBrief, isAiConfigured } from '@/lib/services/ai';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `getLead` is the single access gate: it throws 404 when the lead is missing or
 * outside the actor's scope, so it is used here instead of `canAccessLead`
 * (which is a pure permission check and returns true for org-wide roles
 * regardless of whether the row exists).
 */
async function requireVisibleLead(actor: Parameters<typeof getLead>[0], leadId: string) {
  const lead = await getLead(actor, leadId);
  if (!lead) throw new ApiError(404, 'Lead not found', 'NOT_FOUND');
}

export const GET = withApi(async (actor, _req, ctx) => {
  requirePermission(actor.user, 'leads.view');
  const leadId = await param(ctx, 'id');
  await requireVisibleLead(actor, leadId);
  // `configured` lets the UI show a real "not set up" state instead of a dead
  // button, and never leaks the key itself.
  return { configured: isAiConfigured(), brief: await getLeadBrief(leadId) };
});

export const POST = withApi(async (actor, _req, ctx) => {
  requirePermission(actor.user, 'leads.update');
  const leadId = await param(ctx, 'id');
  await requireVisibleLead(actor, leadId);
  if (!isAiConfigured()) {
    throw new ApiError(503, 'AI is not configured on this server', 'AI_NOT_CONFIGURED');
  }
  try {
    return { brief: await generateLeadBrief(actor, leadId) };
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === 'Lead not found') throw new ApiError(404, msg, 'NOT_FOUND');
    console.error('[ai] groq call failed', msg);
    throw new ApiError(502, 'AI provider request failed', 'AI_UPSTREAM_ERROR');
  }
});
