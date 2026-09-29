import { withApi } from '@/lib/handlers';
import { requirePermission } from '@/lib/api';
import { db } from '@/lib/db';
import { integrations } from '@/lib/db/schema';
import { appTimeZone } from '@/lib/reminders';
import { getSecretSetting, getSetting } from '@/lib/settings';
import { isSecretEncryptionConfigured, looksEncrypted } from '@/lib/secrets';
import { eq, sql } from 'drizzle-orm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Check = { ok: boolean; source: 'ui' | 'env' | 'db' | 'none' | 'default'; detail?: string };

/**
 * Go-live readiness for a fresh instance (white-label / multi-place selling).
 * Each check answers "is this configured, and from where?" so an admin can
 * onboard a new deployment from the UI alone: DB reachable?, encryption key
 * present (bootstrap only), Meta/emails/webhook secret saved?, timezone set?
 * Secret values are never returned - only booleans and non-sensitive details.
 */
export const GET = withApi(async (actor): Promise<{ checks: Record<string, Check> }> => {
  requirePermission(actor.user, 'settings.manage');

  let dbOk = true;
  try {
    await db.execute(sql`select 1`);
  } catch {
    dbOk = false;
  }

  const [metaRow, resendRow, smtpRow] = await Promise.all([
    db.query.integrations.findFirst({ where: eq(integrations.provider, 'meta') }),
    db.query.integrations.findFirst({ where: eq(integrations.provider, 'resend') }),
    db.query.integrations.findFirst({ where: eq(integrations.provider, 'smtp') }),
  ]);

  const metaUi =
    !!metaRow?.isActive &&
    typeof metaRow.config?.pageToken === 'string' &&
    looksEncrypted(metaRow.config.pageToken);
  const metaEnv =
    !!process.env.META_APP_SECRET?.trim() ||
    !!process.env.FB_PAGE_ACCESS_TOKEN?.trim() ||
    !!process.env.META_LEADS_VERIFY_TOKEN?.trim();

  const resendUi =
    !!resendRow?.isActive &&
    typeof resendRow.config?.apiKey === 'string' &&
    looksEncrypted(resendRow.config.apiKey);
  const resendEnv = !!process.env.RESEND_API_KEY?.trim();

  // SMTP is the preferred outbound channel; Resend is the fallback. A provider
  // counts as configured only when it is active AND carrying a real secret
  // (encrypted in the DB or present in env) plus its host.
  const smtpUi =
    !!smtpRow?.isActive &&
    typeof smtpRow.config?.host === 'string' &&
    smtpRow.config.host.trim().length > 0 &&
    typeof smtpRow.config?.appPassword === 'string' &&
    looksEncrypted(smtpRow.config.appPassword);
  const smtpEnv =
    !!process.env.SMTP_APP_PASSWORD?.trim() && !!process.env.SMTP_HOST?.trim();

  const emailOk = smtpUi || smtpEnv || resendUi || resendEnv;
  const emailSource: Check['source'] = smtpUi
    ? 'ui'
    : smtpEnv
      ? 'env'
      : resendUi
        ? 'ui'
        : resendEnv
          ? 'env'
          : 'none';

  const webhookSecret = await getSecretSetting(
    'integrations.meta_webhook_secret',
    process.env.WEBHOOK_SECRET,
  );
  const storedWebhook = await getSetting<string | null>('integrations.meta_webhook_secret', null);
  const webhookSource: Check['source'] =
    typeof storedWebhook === 'string' && storedWebhook.trim().length > 0 ? 'db' : 'env';

  const savedTimezone = (await getSetting<string>('app.timezone', '')).trim();
  const envTimezone = process.env.APP_TIMEZONE?.trim();
  const timezoneSource = savedTimezone ? ('db' as const) : envTimezone ? ('env' as const) : 'default';
  const timezoneValue = (savedTimezone || envTimezone || appTimeZone()).trim();

  return {
    checks: {
      database: { ok: dbOk, source: dbOk ? 'db' : 'none' },
      encryptionKey: { ok: isSecretEncryptionConfigured(), source: 'env' },
      meta: {
        ok: metaUi || metaEnv,
        source: metaUi ? 'ui' : metaEnv ? 'env' : 'none',
      },
      email: {
        ok: emailOk,
        source: emailSource,
        detail: smtpUi || smtpEnv ? 'SMTP' : resendUi || resendEnv ? 'Resend' : undefined,
      },
      webhookSecret: {
        ok: webhookSecret !== null,
        source: webhookSecret !== null ? webhookSource : 'none',
      },
      timezone: {
        ok: timezoneValue.length > 0,
        source: timezoneSource,
        detail: timezoneValue,
      },
    } satisfies Record<string, Check>,
  };
});