import { NextRequest, NextResponse } from 'next/server';
import { withPublic } from '@/lib/handlers';
import { metaConfig, processLeadgen } from '@/lib/services/meta';
import { verifyMetaSignature } from '@/lib/metaSignature';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface MetaLeadgenValue {
  leadgen_id?: string;
  page_id?: string;
  form_id?: string;
  ad_id?: string;
  ad_name?: string;
  is_test?: boolean;
}

/**
 * Meta/Instagram Lead Ads webhook.
 * GET  — webhook verification (hub.mode / hub.verify_token / hub.challenge)
 * POST — processes `leadgen` change events → fetches Graph API data → creates leads.
 */
export const GET = withPublic(async (req: NextRequest) => {
  const params = req.nextUrl.searchParams;
  const mode = params.get('hub.mode');
  const verifyToken = params.get('hub.verify_token');
  const challenge = params.get('hub.challenge');

  const expected = process.env.META_LEADS_VERIFY_TOKEN ?? '';
  if (!expected) {
    return NextResponse.json({ error: { message: 'META_LEADS_VERIFY_TOKEN not configured in .env' } }, { status: 503 });
  }
  if (mode === 'subscribe' && verifyToken === expected && challenge) {
    return new NextResponse(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }
  return NextResponse.json({ error: { message: 'Verification failed' } }, { status: 403 });
});

export const POST = withPublic(async (req: NextRequest) => {
  // Read the raw bytes before any parsing. Meta signs the exact body it sent,
  // so `req.json()` first would destroy the bytes the digest is computed over.
  const raw = await req.text();
  const { appSecret } = await metaConfig();
  const signature = verifyMetaSignature(raw, req.headers.get('x-hub-signature-256'), appSecret);

  if (!signature.ok) {
    // A missing secret is our misconfiguration, not a bad request, so it is a
    // 503 and never a silent pass-through. 401s are not retried by Meta, which
    // is what we want: replaying a forged delivery achieves nothing.
    const status = signature.reason === 'missing-secret' ? 503 : 401;
    return NextResponse.json(
      {
        error: {
          message:
            signature.reason === 'missing-secret'
              ? 'META_APP_SECRET not configured — inbound lead events cannot be authenticated'
              : 'X-Hub-Signature-256 verification failed',
          reason: signature.reason,
        },
      },
      { status },
    );
  }

  // Signature already passed, so a parse failure here is a genuinely malformed
  // signed delivery rather than an attack, and 400 (no retry) is the right code.
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: { message: 'Invalid JSON' } }, { status: 400 });
  }

  const results: Array<{ leadgenId: string; created: boolean; leadId?: string }> = [];
  const errors: Array<{ source: string; error: string }> = [];

  const changes = (body?.entry ?? []).flatMap((entry: any) => entry.changes ?? []);

  if (!changes.length) {
    // allow a simplified test body: { provider:'meta', leadgen_id, page_id, ... }
    if (body?.leadgen_id) {
      try {
        const r = await processLeadgen({
          leadgenId: String(body.leadgen_id),
          pageId: body.page_id,
          formId: body.form_id,
          adId: body.ad_id,
          adName: body.ad_name,
          isTest: body.is_test,
        });
        if (r.created) results.push({ leadgenId: String(body.leadgen_id), created: true, leadId: r.leadId });
        else errors.push({ source: String(body.leadgen_id), error: r.reason ?? 'not processed' });
      } catch (e) {
        errors.push({ source: String(body.leadgen_id), error: (e as Error).message });
      }
    } else {
      // Meta ping without leadgen changes — still OK
      return NextResponse.json({ ok: true, received: 0 });
    }
  }

  for (const change of changes) {
    if (change.field !== 'leadgen') continue;
    const value: MetaLeadgenValue = change.value ?? {};
    if (!value.leadgen_id) continue;
    try {
      const r = await processLeadgen({
        leadgenId: String(value.leadgen_id),
        pageId: value.page_id,
        formId: value.form_id,
        adId: value.ad_id,
        adName: value.ad_name,
        isTest: value.is_test,
      });
      if (r.created) results.push({ leadgenId: String(value.leadgen_id), created: true, leadId: r.leadId });
      else errors.push({ source: String(value.leadgen_id), error: r.reason ?? 'not processed' });
    } catch (e) {
      errors.push({ source: String(value.leadgen_id), error: (e as Error).message });
    }
  }

  // Always return 200 so Meta does not retry/pause delivery.
  return NextResponse.json({ ok: true, received: results.length, errors });
});