import { withApi } from '@/lib/handlers';
import { listLeads, createLead } from '@/lib/services/leads';
import { requirePermission, pagination } from '@/lib/api';
import { readJson } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApi(async (actor, req) => {
  requirePermission(actor.user, 'leads.view');
  const sp = req.nextUrl.searchParams;
  const { page, pageSize } = pagination(sp);
  const result = await listLeads(actor, {
    status: sp.get('status') ?? undefined,
    source: sp.get('source') ?? undefined,
    priority: sp.get('priority') ?? undefined,
    projectId: sp.get('projectId') ?? undefined,
    ownerFilter: (sp.get('owner') as any) ?? undefined,
    search: sp.get('q') ?? undefined,
    from: sp.get('from') ?? undefined,
    to: sp.get('to') ?? undefined,
    page,
    pageSize,
  });
  return { ...result, page, pageSize };
});

export const POST = withApi(async (actor, req) => {
  requirePermission(actor.user, 'leads.create');
  const body = await readJson(req);
  const result = await createLead(actor, body);
  return { ...result, ok: true };
});