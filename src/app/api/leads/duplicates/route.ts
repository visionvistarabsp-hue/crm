import { withApi } from '@/lib/handlers';
import { resolveDuplicateV2 } from '@/lib/services/leads';
import { requirePermission } from '@/lib/api';
import { readJson } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withApi(async (actor, req) => {
  requirePermission(actor.user, 'leads.merge');
  const body: any = await readJson(req);
  await resolveDuplicateV2(actor, body.leadId, body.duplicateOfId, body.resolution);
  return { ok: true };
});