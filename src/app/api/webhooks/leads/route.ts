import { withApi } from '@/lib/handlers';
import { db } from '@/lib/db';
import { incomingLeads } from '@/lib/db/schema';
import { getSecretSetting } from '@/lib/settings';
import { webhookLeadSchema } from '@/lib/validators';
import { aliasSourceRef, applyIncomingLead, enqueueSyncRetry } from '@/lib/services/incomingLeadSync';
import { eq } from 'drizzle-orm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Provider webhook: normalize an external lead into the pipeline.
// Protected by a shared secret when configured. The secret can be set from the
// Settings UI (saved under `integrations.meta_webhook_secret`) or, for older
// deployments, via the WEBHOOK_SECRET env var; a UI-set value wins so a new
// instance never needs a redeploy to wire up lead capture.
export const POST = withApi(async (actor, req) => {
  const secret = await getSecretSetting('integrations.meta_webhook_secret', process.env.WEBHOOK_SECRET);
  if (secret && req.headers.get('x-webhook-secret') !== secret) {
    return { error: { message: 'Invalid webhook secret' }, status: 403 };
  }
  const body: any = await req.json().catch(() => null);
  if (!body) return { error: { message: 'Invalid JSON' }, status: 400 };

  const provider = (body.provider ?? 'external') as string;

  // Provider-side stable ids disagree on the field name: the payloads seen in
  // prod send `lead_id` (e.g. ext_794887) while the app's dedup key is
  // `sourceRef`. Alias it before validation, otherwise a redelivery of the same
  // provider lead would quietly create a brand-new lead and leave phone-based
  // identity fallback as the only net. The original delivery stays in the
  // receipt's raw_payload for audit.
  const normalized = aliasSourceRef(body);

  // The receipt row is this delivery's audit trail, so every status write below
  // must be scoped to it. An unscoped update would rewrite the status of *every*
  // inbound row in the table, corrupting other providers' history.
  const [incoming] = await db
    .insert(incomingLeads)
    .values({ provider, rawPayload: body, status: 'RECEIVED' })
    .returning();

  const markError = (message: string) =>
    db
      .update(incomingLeads)
      .set({ status: 'ERROR', error: message })
      .where(eq(incomingLeads.id, incoming.id));

  const parsed = webhookLeadSchema.safeParse(normalized);
  if (!parsed.success) {
    await markError(parsed.error.message);
    return { error: { message: parsed.error.issues[0]?.message }, status: 422 };
  }

  try {
    const result = await applyIncomingLead(actor, incoming, parsed.data, body);

    return {
      leadId: result.leadId,
      leadNo: result.leadNo,
      duplicates: result.duplicates,
      // A redelivery of a lead we already have, or one claimed by a racing
      // delivery: success, but nobody is alerted or assigned a second time.
      ...(result.created ? {} : { duplicate: true }),
      ok: true,
    };
  } catch (err) {
    // Transient failure (DB blip, momentarily empty assignment pool). Do NOT
    // burn the receipt to ERROR - it stays RECEIVED as the audit trail of an
    // in-flight delivery, and an INTEGRATION_SYNC job retries the sync with
    // backoff. The 500 still surfaces so the provider schedules its own retry,
    // but the digest key makes this delivery's retry exactly-once.
    await enqueueSyncRetry(incoming.id, actor).catch(() => undefined);
    throw err;
  }
});