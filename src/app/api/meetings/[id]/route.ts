import { withApi, param } from '@/lib/handlers';
import { updateMeeting, deleteMeeting, setMeetingStatus } from '@/lib/services/meetings';
import { requirePermission } from '@/lib/api';
import { readJson } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PATCH = withApi(async (actor, req, ctx) => {
  requirePermission(actor.user, 'meetings.manage');
  const body = await readJson(req);
  const meeting = await updateMeeting(actor, await param(ctx, 'id'), body);
  return meeting ?? { status: 404, error: { message: 'Meeting not found' } };
});

export const DELETE = withApi(async (actor, _req, ctx) => {
  requirePermission(actor.user, 'meetings.manage');
  await deleteMeeting(actor, await param(ctx, 'id'));
});

export const POST = withApi(async (actor, req, ctx) => {
  requirePermission(actor.user, 'meetings.manage');
  const body: any = await readJson(req);
  const meeting = await setMeetingStatus(actor, await param(ctx, 'id'), body.status, { feedback: body.feedback, nextAction: body.nextAction });
  return { meeting, ok: true };
});