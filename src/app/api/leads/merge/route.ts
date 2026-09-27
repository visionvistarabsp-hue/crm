import { withApi } from '@/lib/handlers';
import { mergeLeads } from '@/lib/services/leads';
import { mergeLeadsSchema } from '@/lib/validators';
import { readJson } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withApi(async (actor, req) => {
  const body = mergeLeadsSchema.parse(await readJson(req));
  const lead = await mergeLeads(actor, body.sourceId, body.targetId);
  return { lead, ok: true };
});