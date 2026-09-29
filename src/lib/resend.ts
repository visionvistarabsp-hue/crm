import { eq } from 'drizzle-orm';
import { db } from './db';
import { integrations } from './db/schema';
import { decryptSecret, looksEncrypted } from './secrets';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const RESEND_TEST_FROM = 'onboarding@resend.dev';
const REQUEST_TIMEOUT_MS = 15_000;

export interface ResendConfig {
  apiKey: string;
  fromEmail: string;
  fromName: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSent {
  id: string | null;
}

export function defaultFromEmail(): string {
  return process.env.EMAIL_FROM?.trim() || RESEND_TEST_FROM;
}

export function defaultFromName(): string {
  return process.env.EMAIL_FROM_NAME?.trim() || 'CRM';
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
}

function fromHeader(config: ResendConfig): string {
  return config.fromName ? `${config.fromName} <${config.fromEmail}>` : config.fromEmail;
}

/**
 * Resolve the active Resend credentials. An enabled integration row wins so an
 * admin can rotate the key from the UI; `RESEND_API_KEY` is the fallback for
 * deployments that configure the provider purely through the environment.
 * Returns null when no usable credential exists, so callers can degrade instead
 * of crashing.
 */
export async function resolveResendConfig(): Promise<ResendConfig | null> {
  let row: typeof integrations.$inferSelect | undefined;
  try {
    row = await db.query.integrations.findFirst({ where: eq(integrations.provider, 'resend') });
  } catch {
    row = undefined;
  }

  if (row?.isActive) {
    const config = (row.config ?? {}) as Record<string, unknown>;
    const stored = typeof config.apiKey === 'string' ? config.apiKey : null;
    if (stored && looksEncrypted(stored)) {
      let apiKey: string | null = null;
      try {
        apiKey = decryptSecret(stored);
      } catch {
        apiKey = null;
      }
      if (apiKey) {
        return {
          apiKey,
          fromEmail:
            typeof config.fromEmail === 'string' && config.fromEmail.trim()
              ? config.fromEmail.trim()
              : defaultFromEmail(),
          fromName:
            typeof config.fromName === 'string' && config.fromName.trim()
              ? config.fromName.trim()
              : defaultFromName(),
        };
      }
    }
  }

  const envKey = process.env.RESEND_API_KEY?.trim();
  if (!envKey) return null;
  return { apiKey: envKey, fromEmail: defaultFromEmail(), fromName: defaultFromName() };
}

/**
 * Send a transactional email. Throws on a non-2xx response so the queue's retry
 * wrapper can back off and try again.
 */
export async function sendEmail(config: ResendConfig, message: EmailMessage): Promise<EmailSent> {
  const to = message.to.trim();
  if (!isValidEmail(to)) {
    throw new Error(`Refusing to send email to an invalid address: ${to || '(empty)'}`);
  }

  const response = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromHeader(config),
      to: [to],
      subject: message.subject,
      text: message.text,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Resend request failed with status ${response.status}: ${raw.slice(0, 300)}`);
  }

  let id: string | null = null;
  try {
    id = (JSON.parse(raw) as { id?: string | null }).id ?? null;
  } catch {
    id = null;
  }
  return { id };
}
