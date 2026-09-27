import { withApi } from '@/lib/handlers';
import { createLead, findDuplicateLeadsByIdentity } from '@/lib/services/leads';
import { webhookLeadSchema } from '@/lib/validators';
import { db } from '@/lib/db';
import { incomingLeads } from '@/lib/db/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Provider webhook: normalize an external lead into the pipeline.
// Protected by a shared secret when configured (WEBHOOK_SECRET).
export const POST = withApi(async (actor, req) => {
  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.headers.get('x-webhook-secret') !== secret) {
    return { error: { message: 'Invalid webhook secret' }, status: 403 };
  }
  const body: any = await req.json().catch(() => null);
  if (!body) return { error: { message: 'Invalid JSON' }, status: 400 };

  const provider = (body.provider ?? 'external') as string;
  await db.insert(incomingLeads).values({ provider, rawPayload: body, status: 'RECEIVED' });

  const parsed = webhookLeadSchema.safeParse(body);
  if (!parsed.success) {
    await db.update(incomingLeads).set({ status: 'ERROR', error: parsed.error.message });
    return { error: { message: parsed.error.issues[0]?.message }, status: 422 };
  }
  const data = parsed.data;

  const dupes = await findDuplicateLeadsByIdentity(data);
  const result = await createLead(actor, {
    name: data.name,
    phone: data.phone,
    whatsapp: data.whatsapp,
    email: data.email,
    campaign: data.campaign,
    adName: data.adName,
    projectId: data.project as string | undefined,
    budget: data.budget,
    preferredLocation: data.preferredLocation,
    propertyType: data.propertyType,
    requirement: data.requirement,
    sourceRef: data.sourceRef,
    source: 'WEBSITE',
    notes: `Imported via ${provider} webhook`,
    meta: { raw: data.raw },
  });

  await db.update(incomingLeads).set({ status: 'CREATED', leadId: result.lead.id, normalized: body });
  return { leadId: result.lead.id, leadNo: result.lead.leadNo, duplicates: dupes.length, ok: true };
});