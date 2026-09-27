import { eq, sql } from 'drizzle-orm';
import { db } from './index';
import { users } from './schema';
import { hashPassword } from '../password';

export const DEFAULT_ADMIN_EMAIL = 'crm@gmail.com';
export const DEFAULT_ADMIN_PASSWORD = 'crm123';
const DEFAULT_ADMIN_NAME = 'CRM Admin';

/**
 * Create (or repair) the built-in super-admin account. Idempotent: safe to run
 * on every deploy.
 *
 * This deliberately bypasses the signup password policy. That policy exists to
 * stop users picking weak passwords, but this is a fixed operator-owned
 * bootstrap credential the app ships with, not a user choice — and the
 * documented default is 6 characters.
 */
export async function ensureAdminUser(
  email: string = DEFAULT_ADMIN_EMAIL,
  password: string = DEFAULT_ADMIN_PASSWORD,
) {
  const normalized = email.trim().toLowerCase();
  const [existing] = await db
    .select({ id: users.id, hasPassword: sql<boolean>`password_hash is not null` })
    .from(users)
    .where(sql`lower(${users.email}) = ${normalized}`)
    .limit(1);

  if (existing) {
    // Only write when something is actually missing, so restarts don't
    // invalidate the operator's active session or churn the row.
    const patch: Partial<typeof users.$inferInsert> = { role: 'SUPER_ADMIN', isActive: true };
    if (!existing.hasPassword) patch.passwordHash = await hashPassword(password);
    await db.update(users).set(patch).where(eq(users.id, existing.id));
    return { id: existing.id, email: normalized, created: false, passwordSet: !existing.hasPassword };
  }

  const [created] = await db
    .insert(users)
    .values({
      name: DEFAULT_ADMIN_NAME,
      email: normalized,
      passwordHash: await hashPassword(password),
      role: 'SUPER_ADMIN',
      isActive: true,
    })
    .returning({ id: users.id });

  return { id: created.id, email: normalized, created: true, passwordSet: true };
}
