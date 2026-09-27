import { db } from './db';
import { settings } from './db/schema';
import { eq } from 'drizzle-orm';

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