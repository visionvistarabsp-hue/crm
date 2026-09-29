import { ApiError, requirePermission } from '@/lib/api';
import { withApi } from '@/lib/handlers';
import { metaConfig } from '@/lib/services/meta';
import { computeMetaSignature } from '@/lib/metaSignature';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/integrations/meta/test
 *
 * Sends a synthetic Meta ping (`is_test: true`) through the real webhook
 * endpoint, signed with the configured app secret. This exercises the full
 * inbound path (signature verification → leadgen parse → IGNORED receipt) so
 * an admin can confirm delivery works without creating a real ad.
 */
export const POST = withApi(async (actor, req) => {
  requirePermission(actor.user, 'settings.manage');

  const { appSecret, verifyToken } = await metaConfig();
  if (!appSecret) {
    throw new ApiError(503, 'META_APP_SECRET is not configured. Save it in Settings → Integration keys first.');
  }

  const leadgenId = `test_${Date.now()}`;
  const body = JSON.stringify({
    entry: [
      {
        id: '0',
        time: Math.floor(Date.now() / 1000),
        changes: [
          {
            field: 'leadgen',
            value: {
              leadgen_id: leadgenId,
              page_id: '0',
              form_id: '0',
              ad_id: '0',
              ad_name: 'Test lead',
              is_test: true,
            },
          },
        ],
      },
    ],
  });

  const signature = computeMetaSignature(body, appSecret);

  let res: Response;
  try {
    res = await fetch(new URL('/api/webhooks/meta/leads', req.nextUrl.origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      body,
    });
  } catch (e) {
    throw new ApiError(502, `Webhook self-call failed: ${(e as Error).message}`);
  }

  const data: any = await res.json().catch(() => null);

  if (!res.ok) {
    const msg = data?.error?.message ?? `webhook replied HTTP ${res.status}`;
    throw new ApiError(502, `Signature or end-to-end check failed: ${msg}`);
  }

  // An is_test lead is deliberately not created, so the webhook reports it as
  // an error entry with reason 'test'. That entry is the expected confirmation
  // a test ping worked; anything else is a real failure.
  const errors: Array<{ source?: unknown; error?: unknown }> = Array.isArray(data?.errors) ? data.errors : [];
  const unexpected = errors.filter((e) => e.error !== 'test');
  if (unexpected.length > 0) {
    throw new ApiError(502, `Webhook processed the ping but reported: ${unexpected.map((e) => String(e.error)).join(', ')}`);
  }

  return {
    ok: true,
    message: verifyToken
      ? `Test lead delivered. Signature verified and an ignored receipt was recorded (${leadgenId}).`
      : `Test lead delivered and signature verified, but the verify token is missing — Meta's subscription handshake (GET /webhooks/meta/leads) will fail until you save one.`,
    leadgenId,
    verifyTokenConfigured: Boolean(verifyToken),
  };
});