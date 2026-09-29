import { db } from './db';
import { settings } from './db/schema';
import { eq } from 'drizzle-orm';
import { decryptSecret, looksEncrypted } from './secrets';

export async function getSetting<T = unknown>(key: string, fallback: T): Promise<T> {
  try {
    const row = await db.query.settings.findFirst({ where: eq(settings.key, key) });
    return (row?.value as T) ?? fallback;
  } catch {
    return fallback;
  }
}

export async function setSetting<T = unknown>(key: string, value: T): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

export async function incrementSetting(key: string, step = 1): Promise<number> {
  const current = (await getSetting<number>(key, 0)) ?? 0;
  const next = current + step;
  await setSetting(key, next);
  return next;
}

/**
 * Resolve a secret management by the Settings UI. A value saved under `key`
 * wins (both a plaintext value from the generic settings form and an
 * AES-256-GCM `v1:` blob saved by an integration flow are accepted), and
 * `envFallback` is used only when nothing usable is stored. Storing the secret
 * in the database makes a new instance fully configurable from the UI without
 * redeploying to rotate the value.
 */
export async function getSecretSetting(key: string, envFallback?: string): Promise<string | null> {
  const stored = await getSetting<string | null>(key, null);
  if (typeof stored === 'string' && stored.trim().length > 0) {
    const value = stored.trim();
    if (looksEncrypted(value)) {
      try {
        const decrypted = decryptSecret(value);
        if (decrypted.length > 0) return decrypted;
      } catch {
        return envFallback?.trim() || null;
      }
    }
    return value;
  }
  return envFallback?.trim() || null;
}