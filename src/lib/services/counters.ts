import { db } from '../db';
import { counters } from '../db/schema';
import { sql } from 'drizzle-orm';
import { pad } from '../utils';

export type DbLike = any;

/**
 * Atomically mint the next number in a keyed sequence and format it
 * as `<PREFIX>-000N`. Safe under concurrency via an UPSERT.
 */
export async function nextNumber(
  key: string,
  prefix: string,
  width = 4,
  client: DbLike = db,
): Promise<string> {
  const rows = await client.execute(
    sql`INSERT INTO ${counters} (key, value) VALUES (${key}, 1)
        ON CONFLICT (key) DO UPDATE SET value = ${counters}.value + 1
        RETURNING value`,
  );
  const result = rows as unknown as { rows?: Array<{ value: number }> };
  const value = result.rows?.[0]?.value ?? 1;
  return `${prefix}-${pad(value, width)}`;
}

export async function peekNumber(key: string, prefix: string, width = 4): Promise<string> {
  const rows = await db.select({ value: counters.value }).from(counters).where(sql`${counters.key} = ${key}`);
  return `${prefix}-${pad((rows[0]?.value ?? 0) + 1, width)}`;
}