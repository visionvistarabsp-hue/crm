import { withApi } from '@/lib/handlers';
import { listFollowups, createFollowup } from '@/lib/services/followups';
import { requirePermission, pagination } from '@/lib/api';
import { readJson } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApi(async (actor, req) => {
  requirePermission(actor.user, 'followups.manage');
  const sp = req.nextUrl.searchParams;
  const { page, pageSize } = pagination(sp);
  const view = (sp.get('view') as any) ?? 'today';
  const result = await listFollowups(actor, {
    view,
    assignedTo: sp.get('assignedTo') ?? undefined,
    leadId: sp.get('leadId') ?? undefined,
    customerId: sp.get('customerId') ?? undefined,
    page,
    pageSize,
  });
  return { ...result, page, pageSize, view };
});

export const POST = withApi(async (actor, req) => {
  requirePermission(actor.user, 'followups.manage');
  const body = await readJson(req);
  const followup = await createFollowup(actor, body);
  return { followup, ok: true };
});