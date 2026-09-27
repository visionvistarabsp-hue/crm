import { withApi, param } from '@/lib/handlers';
import { addLeadActivity } from '@/lib/services/leads';
import { db } from '@/lib/db';
import { leadActivities } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { readJson } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApi(async (actor, _req, ctx) => {
  const id = await param(ctx, 'id');
  const rows = await db.query.leadActivities.findMany({ where: eq(leadActivities.leadId, id), orderBy: (a, { desc }) => [desc(a.createdAt)] });
  return { items: rows };
});

export const POST = withApi(async (actor, req, ctx) => {
  const body = await readJson(req);
  await addLeadActivity(actor, await param(ctx, 'id'), body);
  return { ok: true };
});