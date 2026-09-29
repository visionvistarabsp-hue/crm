import { eq } from 'drizzle-orm';
import { db } from './db';
import { integrations } from './db/schema';
import { decryptSecret, looksEncrypted } from './secrets';
import { registerJobHandler, type JobHandler } from './queue';

/**
 * Meta Graph API version the WhatsApp Cloud API integration pins to. The
 * messages endpoint lives at /{version}/{phone_number_id}/messages.
 */
const GRAPH_VERSION = 'v22.0';
const REQUEST_TIMEOUT_MS = 15_000;

/** Template used when the operator has not configured one. */
const DEFAULT_TEMPLATE_NAME = 'lead_alert';
/** BCP-47 language the default template is approved in. */
const DEFAULT_TEMPLATE_LANGUAGE = 'en';

export interface WhatsAppConfig {
  /** Permanent system-user access token for the WhatsApp Business Account. */
  accessToken: string;
  /** Numeric ID of the sending phone number (`phone_number_id`). */
  phoneNumberId: string;
  /** Display (E.164) business number. Informational only; the API sends from the number id. */
  fromPhone: string;
  /** Name of an approved template, e.g. `lead_alert`. */
  templateName: string;
  /** BCP-47 language code the template was approved in, e.g. `en`. */
  templateLanguage: string;
}

export interface WhatsAppMessage {
  /** Recipient phone number in E.164, e.g. `+919876543210`. */
  to: string;
  /** Per-send overrides; fall back to the configured template. */
  templateName?: string;
  templateLanguage?: string;
  /** Text values for the template body placeholders, in order (`{{1}}`, `{{2}}`, ...). */
  bodyParams: string[];
}

export interface WhatsAppSent {
  /** Message id Meta returns when the send is accepted. */
  id: string | null;
}

/** Loose E.164 check used before a WhatsApp job is enqueued or sent. */
export function isValidPhone(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(value.trim());
}

/**
 * Best-effort conversion of a stored phone number into E.164. A bare 10-digit
 * national number is assumed to be India (`+91`, matching the app's default
 * timezone), and `91...` is treated as an already-long-form Indian number.
 * Returns null when the string cannot be interpreted so callers can skip the
 * user instead of dialling a mangled number.
 */
export function toE164(value: string): string | null {
  const raw = value.trim();
  const digits = raw.replace(/\D/g, '');
  let candidate: string;
  if (/^\+\d{1,15}$/.test(raw)) {
    candidate = raw;
  } else if (/^[1-9]\d{9}$/.test(digits)) {
    candidate = `+91${digits}`;
  } else if (/^91[1-9]\d{9}$/.test(digits)) {
    candidate = `+${digits}`;
  } else {
    return null;
  }
  return isValidPhone(candidate) ? candidate : null;
}

/**
 * Resolve the active WhatsApp Cloud API credentials. An enabled integration
 * row wins so an admin can rotate the access token from the UI;
 * `WHATSAPP_ACCESS_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` are the fallback for
 * env-only deployments. Returns null when no usable credential exists, so
 * callers can degrade instead of crashing.
 */
export async function resolveWhatsAppConfig(): Promise<WhatsAppConfig | null> {
  let row: typeof integrations.$inferSelect | undefined;
  try {
    row = await db.query.integrations.findFirst({ where: eq(integrations.provider, 'whatsapp') });
  } catch {
    row = undefined;
  }

  const readEnv = (name: string): string => process.env[name]?.trim() ?? '';
  const readStored = (key: string): string => {
    const config = (row?.config ?? {}) as Record<string, unknown>;
    return typeof config[key] === 'string' ? (config[key] as string).trim() : '';
  };

  let accessToken = readEnv('WHATSAPP_ACCESS_TOKEN');
  let phoneNumberId = readEnv('WHATSAPP_PHONE_NUMBER_ID');
  let fromPhone = readEnv('WHATSAPP_FROM_PHONE');
  let templateName = readEnv('WHATSAPP_TEMPLATE_NAME');
  let templateLanguage = readEnv('WHATSAPP_TEMPLATE_LANGUAGE');

  if (row?.isActive) {
    const storedToken = readStored('accessToken');
    if (storedToken && looksEncrypted(storedToken)) {
      try {
        const decrypted = decryptSecret(storedToken);
        if (decrypted) accessToken = decrypted;
      } catch {
        // Corrupt ciphertext: the env fallback below still applies.
      }
    }
    phoneNumberId = readStored('phoneNumberId') || phoneNumberId;
    fromPhone = readStored('fromPhone') || fromPhone;
    templateName = readStored('templateName') || templateName;
    templateLanguage = readStored('templateLanguage') || templateLanguage;
  }

  if (!accessToken || !phoneNumberId) return null;

  return {
    accessToken,
    phoneNumberId,
    fromPhone,
    templateName: templateName || DEFAULT_TEMPLATE_NAME,
    templateLanguage: templateLanguage || DEFAULT_TEMPLATE_LANGUAGE,
  };
}

/**
 * Send a template message through the WhatsApp Business Cloud API.
 * Business-initiated messages must use an approved template, so the body text
 * is slot into the configured template's placeholders. Throws on failure so
 * the queue's retry wrapper can back off and try again.
 */
export async function sendWhatsAppMessage(
  config: WhatsAppConfig,
  message: WhatsAppMessage,
): Promise<WhatsAppSent> {
  const to = message.to.trim();
  if (!isValidPhone(to)) {
    throw new Error(`Refusing to send WhatsApp to an invalid number: ${to || '(empty)'}`);
  }

  const template = {
    name: message.templateName?.trim() || config.templateName,
    language: { code: message.templateLanguage?.trim() || config.templateLanguage },
    ...(message.bodyParams.length > 0
      ? {
          components: [
            {
              type: 'body',
              parameters: message.bodyParams.map((text) => ({ type: 'text', text })),
            },
          ],
        }
      : {}),
  } as Record<string, unknown>;

  const response = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${config.phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`WhatsApp request failed with status ${response.status}: ${raw.slice(0, 300)}`);
  }

  let id: string | null = null;
  try {
    const json = JSON.parse(raw) as { messages?: Array<{ id?: string }> };
    id = json.messages?.[0]?.id ?? null;
  } catch {
    id = null;
  }
  return { id };
}

/**
 * Dedicated handler for `WHATSAPP` jobs, mirroring the EMAIL handler: it
 * validates the payload, then resolves config at send time and throws when
 * unconfigured, so the queue's retry loop can surface the failure.
 */
export async function registerWhatsAppHandler(): Promise<void> {
  const handler: JobHandler = async (payload) => {
    const data = payload as Record<string, unknown>;
    const to = typeof data.to === 'string' ? data.to : '';
    const bodyParams = Array.isArray(data.bodyParams)
      ? (data.bodyParams as unknown[]).map((p) => String(p))
      : [];
    if (!isValidPhone(to) || bodyParams.length === 0) {
      throw new Error('WHATSAPP job payload is missing a valid recipient or body parameter');
    }

    const config = await resolveWhatsAppConfig();
    if (!config) {
      throw new Error(
        'WhatsApp is not configured. Save a WhatsApp access token and phone number id under Settings > Integration keys, or set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID.',
      );
    }

    await sendWhatsAppMessage(config, { to, bodyParams });
  };
  registerJobHandler('WHATSAPP', handler);
}