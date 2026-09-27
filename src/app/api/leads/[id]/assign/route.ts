import { withApi, param } from '@/lib/handlers';
import { assignLead } from '@/lib/services/assignment';
import { db } from '@/lib/db';
import { leads } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { requirePermission } from '@/lib/api';
import { readJson } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withApi(async (actor, req, ctx) => {
  requirePermission(actor.user, 'leads.assign');
  const body: any = await readJson(req);
  const id = await param(ctx, 'id');
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, id) });
  if (!lead) return { error: { message: 'Lead not found' }, status: 404 };
  const result = await assignLead({ lead, actor, forcedUserId: body.userId, rule: body.rule ?? 'MANUAL' });
  return { assignment: result, ok: true };
});