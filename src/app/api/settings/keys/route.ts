import { eq, inArray } from 'drizzle-orm';
import { ApiError, readJson, requirePermission } from '@/lib/api';
import { writeAudit } from '@/lib/audit';
import { db } from '@/lib/db';
import { integrations } from '@/lib/db/schema';
import { LEAD_SOURCES } from '@/lib/constants';
import { withApi } from '@/lib/handlers';
import { decryptSecret, encryptSecret, isSecretEncryptionConfigured, looksEncrypted, maskSecret } from '@/lib/secrets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Secrets are encrypted at rest; plain fields are descriptive only. Each secret
 * keeps its own environment fallback so an operator can migrate a provider
 * from env to the UI without losing the other half of its configuration.
 */
interface ProviderSpec {
  label: string;
  /** Config keys stored encrypted, with the env var that seeds them. */
  secrets: readonly { key: string; env?: string; required: boolean; label: string }[];
  /** Config keys stored as-is. */
  plain: readonly { key: string; label: string }[];
  requiredSecrets: readonly string[];
}

const PROVIDER_SPECS = {
  resend: {
    label: 'Resend',
    secrets: [{ key: 'apiKey', env: 'RESEND_API_KEY', required: true, label: 'Resend API key' }],
    plain: [
      { key: 'fromEmail', label: 'From email' },
      { key: 'fromName', label: 'From name' },
    ],
    requiredSecrets: ['apiKey'],
  },
  meta: {
    label: 'Meta Lead Ads',
    secrets: [
      { key: 'pageToken', env: 'FB_PAGE_ACCESS_TOKEN', required: true, label: 'Page access token' },
      { key: 'verifyToken', env: 'META_LEADS_VERIFY_TOKEN', required: true, label: 'Webhook verify token' },
    ],
    plain: [
      { key: 'facebookPageId', label: 'Facebook page ID' },
      { key: 'instagramAccountId', label: 'Instagram business account ID' },
    ],
    requiredSecrets: ['pageToken', 'verifyToken'],
  },
} as const satisfies Record<string, ProviderSpec>;

const PROVIDERS = Object.keys(PROVIDER_SPECS) as ProviderName[];
type ProviderName = keyof typeof PROVIDER_SPECS;

function assertProvider(value: unknown): ProviderName {
  if (typeof value !== 'string' || !PROVIDERS.includes(value as ProviderName)) {
    throw new ApiError(422, `Unsupported provider. Expected one of: ${PROVIDERS.join(', ')}`, 'VALIDATION');
  }
  return value as ProviderName;
}

function maskOf(stored: unknown): string | null {
  if (typeof stored !== 'string' || !stored) return null;
  if (!looksEncrypted(stored)) return 'stored (not encrypted)';
  try {
    return maskSecret(decryptSecret(stored));
  } catch {
    return 'unreadable';
  }
}

function envPresence(spec: ProviderSpec): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const secret of spec.secrets) {
    if (secret.env) out[secret.key] = Boolean(process.env[secret.env]?.trim());
  }
  return out;
}

export const GET = withApi(async (actor) => {
  requirePermission(actor.user, 'settings.manage');

  const rows = await db.select().from(integrations).where(inArray(integrations.provider, [...PROVIDERS]));
  const byProvider = new Map(rows.map((r) => [r.provider, r]));

  return {
    encryptionConfigured: isSecretEncryptionConfigured(),
    leadSources: LEAD_SOURCES,
    items: PROVIDERS.map((provider) => {
      const spec = PROVIDER_SPECS[provider];
      const row = byProvider.get(provider);
      const config = (row?.config ?? {}) as Record<string, unknown>;
      const env = envPresence(spec);

      const secrets = spec.secrets.map((secret) => {
        const stored = typeof config[secret.key] === 'string' ? (config[secret.key] as string) : null;
        return {
          key: secret.key,
          label: secret.label,
          required: secret.required,
          hasStoredKey: Boolean(stored),
          keyMask: maskOf(stored),
          source: stored ? ('database' as const) : env[secret.key] ? ('environment' as const) : ('none' as const),
        };
      });

      const plain: Record<string, string | null> = {};
      for (const field of spec.plain) {
        plain[field.key] = typeof config[field.key] === 'string' ? (config[field.key] as string) : null;
      }

      const storedCount = secrets.filter((s) => s.hasStoredKey).length;
      return {
        provider,
        label: spec.label,
        secrets,
        plain,
        plainLabels: spec.plain.map((f) => ({ key: f.key, label: f.label })),
        isActive: row?.isActive ?? false,
        configured: storedCount > 0 || secrets.some((s) => s.source === 'environment'),
        source: storedCount > 0 ? ('database' as const) : secrets.some((s) => s.source === 'environment') ? ('environment' as const) : ('none' as const),
      };
    }),
  };
});

export const PUT = withApi(async (actor, req) => {
  requirePermission(actor.user, 'settings.manage');
  if (!isSecretEncryptionConfigured()) {
    throw new ApiError(503, 'Secret storage is not configured. Set SETTINGS_ENCRYPTION_KEY first.', 'CONFIG');
  }

  const body = (await readJson(req)) as {
    provider?: unknown;
    isActive?: unknown;
    formSources?: unknown;
    [key: string]: unknown;
  };
  const provider = assertProvider(body.provider);
  const spec = PROVIDER_SPECS[provider];

  const existing = await db.query.integrations.findFirst({ where: eq(integrations.provider, provider) });
  const config: Record<string, unknown> = { ...((existing?.config ?? {}) as Record<string, unknown>) };

  for (const secret of spec.secrets) {
    if (body[secret.key] === undefined) continue;
    const value = body[secret.key];
    // An empty string clears the stored secret rather than being stored blank.
    if (typeof value !== 'string') {
      throw new ApiError(422, `${secret.label} must be a string`, 'VALIDATION');
    }
    if (!value.trim()) delete config[secret.key];
    else config[secret.key] = encryptSecret(value.trim());
  }

  for (const field of spec.plain) {
    if (body[field.key] === undefined) continue;
    const value = body[field.key];
    config[field.key] = typeof value === 'string' ? value.trim() : '';
  }

  if (provider === 'meta' && body.formSources !== undefined) {
    if (!body.formSources || typeof body.formSources !== 'object' || Array.isArray(body.formSources)) {
      throw new ApiError(422, 'formSources must be an object of formId -> lead source', 'VALIDATION');
    }
    const normalised: Record<string, string> = {};
    for (const [formId, raw] of Object.entries(body.formSources as Record<string, unknown>)) {
      const id = formId.trim();
      const value = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
      if (!id) continue;
      if (!value) {
        normalised[id] = '';
        continue;
      }
      if (!LEAD_SOURCES.includes(value as (typeof LEAD_SOURCES)[number])) {
        throw new ApiError(422, `Unknown lead source "${value}" for form ${id}`, 'VALIDATION');
      }
      normalised[id] = value;
    }
    config.formSources = normalised;
  }

  const missing = spec.requiredSecrets.filter((key) => !config[key]);
  if (missing.length > 0) {
    const labels = missing
      .map((key) => spec.secrets.find((s) => s.key === key)?.label ?? key)
      .join(', ');
    throw new ApiError(422, `${labels} required the first time you save this provider`, 'VALIDATION');
  }

  const isActive = body.isActive === undefined ? true : Boolean(body.isActive);
  const payload = {
    label: spec.label,
    config,
    isActive,
    updatedAt: new Date(),
  };

  const [saved] = await db
    .insert(integrations)
    .values({ provider, ...payload })
    .onConflictDoUpdate({ target: integrations.provider, set: payload })
    .returning();

  await writeAudit({
    actor,
    action: 'UPDATE',
    entity: 'integration',
    entityId: saved.id,
    newValue: { provider, isActive, keysStored: spec.secrets.filter((s) => config[s.key]).map((s) => s.key) },
  });

  return { ok: true, provider, isActive: saved.isActive };
});

export const DELETE = withApi(async (actor, req) => {
  requirePermission(actor.user, 'settings.manage');
  const body = (await readJson(req)) as { provider?: unknown; key?: unknown };
  const provider = assertProvider(body.provider);
  const spec = PROVIDER_SPECS[provider];

  const existing = await db.query.integrations.findFirst({ where: eq(integrations.provider, provider) });
  if (!existing) return { ok: true, removed: false };

  const config = { ...((existing.config ?? {}) as Record<string, unknown>) };

  // A named key removes one secret; omitting it clears every secret, which is
  // what a "reset this provider" action means.
  const targets = typeof body.key === 'string' && body.key ? [body.key] : spec.secrets.map((s) => s.key);
  for (const key of targets) {
    if (!spec.secrets.some((s) => s.key === key)) {
      throw new ApiError(422, `"${key}" is not a secret of provider ${provider}`, 'VALIDATION');
    }
    delete config[key];
  }

  await db
    .update(integrations)
    .set({ config, isActive: false, updatedAt: new Date() })
    .where(eq(integrations.provider, provider));

  await writeAudit({
    actor,
    action: 'UPDATE',
    entity: 'integration',
    entityId: existing.id,
    newValue: { provider, clearedKeys: targets },
  });

  return { ok: true, removed: true, cleared: targets };
});
