import { withApi, param } from '@/lib/handlers';
import { changeStatus } from '@/lib/services/leads';
import { readJson } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withApi(async (actor, req, ctx) => {
  const body = await readJson(req);
  const lead = await changeStatus(actor, await param(ctx, 'id'), body);
  return { lead, ok: true };
});