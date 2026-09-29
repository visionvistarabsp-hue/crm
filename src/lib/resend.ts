import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { integrations } from './db/schema';
import { getSetting } from './settings';
import { decryptSecret, looksEncrypted } from './secrets';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const RESEND_TEST_FROM = 'onboarding@resend.dev';
const REQUEST_TIMEOUT_MS = 15_000;

export interface ResendConfig {
  apiKey: string;
  fromEmail: string;
  fromName: string;
}

/**
 * SMTP transport, used where the operator supplies a real mailbox (e.g. Gmail
 * via SMTP_HOST/SMTP_USER/SMTP_APP_PASSWORD). `secure` mirrors the port:
 * 465 speaks implicit TLS, 587 upgrades through STARTTLS.
 */
export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  appPassword: string;
  fromEmail: string;
  fromName: string;
}

export type EmailConfig = ResendConfig | SmtpConfig;

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSent {
  id: string | null;
}

export function isSmtpConfig(config: EmailConfig): config is SmtpConfig {
  return 'host' in config && 'appPassword' in config && 'secure' in config;
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

function fromHeader(config: { fromEmail: string; fromName: string }): string {
  return config.fromName ? `${config.fromName} <${config.fromEmail}>` : config.fromEmail;
}

function lookupSender() {
  return Promise.all([
    getSetting<string>('email.from_email', ''),
    getSetting<string>('email.from_name', ''),
  ]);
}

/**
 * Resolve the active SMTP credentials. An enabled integration row wins so an
 * admin can rotate the app password from the UI; `SMTP_HOST` / `SMTP_USER` /
 * `SMTP_APP_PASSWORD` are the fallback for env-only deployments. Returns null
 * when no usable credential exists, so callers can degrade instead of crashing.
 */
export async function resolveSmtpConfig(): Promise<SmtpConfig | null> {
  let row: typeof integrations.$inferSelect | undefined;
  try {
    row = await db.query.integrations.findFirst({ where: eq(integrations.provider, 'smtp') });
  } catch {
    row = undefined;
  }

  const config = (row?.config ?? {}) as Record<string, unknown>;
  const read = (key: string, envKey: string): string | null => {
    const stored = typeof config[key] === 'string' ? (config[key] as string).trim() : '';
    return stored || process.env[envKey]?.trim() || null;
  };

  const host = read('host', 'SMTP_HOST');
  const user = read('user', 'SMTP_USER');
  if (!host || !user) return null;

  let appPassword: string | null = null;
  const stored = typeof config.appPassword === 'string' ? config.appPassword : null;
  if (stored && looksEncrypted(stored)) {
    try {
      appPassword = decryptSecret(stored);
    } catch {
      appPassword = null;
    }
  }
  if (!appPassword) appPassword = process.env.SMTP_APP_PASSWORD?.trim() || null;
  if (!appPassword) return null;

  const rawPort = read('port', 'SMTP_PORT') || '465';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  const [dbFromEmail, dbFromName] = await lookupSender();

  return {
    host,
    port,
    secure: port === 465,
    user,
    appPassword,
    fromEmail: dbFromEmail.trim() || defaultFromEmail(),
    fromName: dbFromName.trim() || defaultFromName(),
  };
}

/**
 * Resolve the best available email transport. SMTP wins when configured (the
 * dedicated mailbox is the primary channel); Resend is the fallback so a
 * tenant that only has an API key still gets its notifications.
 */
export async function resolveEmailConfig(): Promise<EmailConfig | null> {
  const smtp = await resolveSmtpConfig();
  if (smtp) return smtp;
  return resolveResendConfig();
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

  // Instance-level overrides saved from the Settings UI beat both the
  // integration row and the env defaults, so an admin can change the sender
  // address without touching code or redeploying.
  const [dbFromEmail, dbFromName] = await lookupSender();
  const resolveFrom = (config?: Record<string, unknown>): string => {
    const fromRow =
      config && typeof config.fromEmail === 'string' && config.fromEmail.trim()
        ? config.fromEmail.trim()
        : null;
    return fromRow || dbFromEmail.trim() || defaultFromEmail();
  };
  const resolveName = (config?: Record<string, unknown>): string => {
    const fromRow =
      config && typeof config.fromName === 'string' && config.fromName.trim()
        ? config.fromName.trim()
        : null;
    return fromRow || dbFromName.trim() || defaultFromName();
  };

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
        return { apiKey, fromEmail: resolveFrom(config), fromName: resolveName(config) };
      }
    }
  }

  const envKey = process.env.RESEND_API_KEY?.trim();
  if (!envKey) return null;
  return { apiKey: envKey, fromEmail: resolveFrom(), fromName: resolveName() };
}

/**
 * Send a transactional email over whichever transport the config describes.
 * Throws on failure so the queue's retry wrapper can back off and try again.
 */
export async function sendEmail(config: EmailConfig, message: EmailMessage): Promise<EmailSent> {
  const to = message.to.trim();
  if (!isValidEmail(to)) {
    throw new Error(`Refusing to send email to an invalid address: ${to || '(empty)'}`);
  }
  if (isSmtpConfig(config)) return sendEmailViaSmtp(config, message);
  return sendViaResend(config, message);
}

async function sendViaResend(config: ResendConfig, message: EmailMessage): Promise<EmailSent> {
  const response = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromHeader(config),
      to: [message.to],
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

/** Shared transports are reused so a burst of reminder emails does not pay a TCP+TLS handshake per send. */
const smtpTransports = new Map<string, Transporter>();

function transportFor(config: SmtpConfig): Transporter {
  const key = `${config.host}:${config.port}:${config.user}`;
  let transport = smtpTransports.get(key);
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.appPassword },
      connectionTimeout: REQUEST_TIMEOUT_MS,
      greetingTimeout: REQUEST_TIMEOUT_MS,
      socketTimeout: REQUEST_TIMEOUT_MS,
    });
    smtpTransports.set(key, transport);
  }
  return transport;
}

export async function sendEmailViaSmtp(config: SmtpConfig, message: EmailMessage): Promise<EmailSent> {
  if (!config.fromEmail || !isValidEmail(config.fromEmail)) {
    throw new Error(`Refusing to send SMTP email from an invalid sender: ${config.fromEmail || '(empty)'}`);
  }
  const transport = transportFor(config);
  const info = await transport.sendMail({
    from: fromHeader(config),
    to: message.to,
    subject: message.subject,
    text: message.text,
  });
  return { id: info.messageId ?? null };
}