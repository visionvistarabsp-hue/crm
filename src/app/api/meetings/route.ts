import { withApi } from '@/lib/handlers';
import { listMeetings, createMeeting } from '@/lib/services/meetings';
import { requirePermission, pagination } from '@/lib/api';
import { readJson } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApi(async (actor, req) => {
  requirePermission(actor.user, 'meetings.manage');
  const sp = req.nextUrl.searchParams;
  const { page, pageSize } = pagination(sp);
  const type = (sp.get('type') as any) ?? 'ALL';
  const result = await listMeetings(actor, {
    type,
    status: sp.get('status') ?? undefined,
    from: sp.get('from') ?? undefined,
    to: sp.get('to') ?? undefined,
    page,
    pageSize,
  });
  return { ...result, page, pageSize };
});

export const POST = withApi(async (actor, req) => {
  requirePermission(actor.user, 'meetings.manage');
  const body = await readJson(req);
  const meeting = await createMeeting(actor, body);
  return { meeting, ok: true };
});