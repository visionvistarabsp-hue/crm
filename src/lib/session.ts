import { createHash, randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { and, eq, gt, lt } from 'drizzle-orm';
import { db } from './db';
import { sessions, users, type Session } from './db/schema';

/**
 * Opaque, server-side session store.
 *
 * The browser holds a 256-bit random token; only its SHA-256 digest is stored,
 * so a database leak cannot be replayed as a login. Every request resolves the
 * token in Node (this module) and reads the live `users` row, which means
 * deactivating a user or changing their role takes effect on the next request
 * without touching existing sessions.
 */

/** Shared with the Edge middleware, which only checks that the cookie exists. */
export const SESSION_COOKIE = 'sp_session';

const DEFAULT_TTL_DAYS = 7;

/** Re-exported so middleware and this module cannot drift apart. */
export function isSecureCookie(): boolean {
  // Behind a proxy in production, cookies must be Secure even on internal http.
  return process.env.NODE_ENV === 'production';
}

export function sessionTtlMs(): number {
  const raw = Number(process.env.SESSION_TTL_DAYS);
  const days = Number.isFinite(raw) && raw > 0 && raw <= 365 ? raw : DEFAULT_TTL_DAYS;
  return days * 24 * 60 * 60 * 1000;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Cookie attributes shared by the set path (login/signup) and clear path (logout). */
function baseCookieOptions(maxAgeSeconds: number) {
  // `as const` keeps sameSite narrow enough for Next's cookie type.
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: isSecureCookie(),
    maxAge: maxAgeSeconds,
  } as const;
}

export interface SessionRequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/** Create a session row and return the raw token to hand to the browser. */
export async function createSession(
  userId: string,
  meta: SessionRequestMeta = {},
): Promise<{ token: string; expiresAt: Date; maxAgeSeconds: number }> {
  const token = randomBytes(32).toString('base64url');
  const ttlMs = sessionTtlMs();
  const maxAgeSeconds = Math.floor(ttlMs / 1000);
  const expiresAt = new Date(Date.now() + ttlMs);

  await db.insert(sessions).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent?.slice(0, 512) ?? null,
  });

  return { token, expiresAt, maxAgeSeconds };
}

/** Write the session cookie. Must be called from a Route Handler / Server Action. */
export async function setSessionCookie(token: string, maxAgeSeconds: number): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, baseCookieOptions(maxAgeSeconds));
}

export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, '', baseCookieOptions(0));
}

/** Read the raw token from the request cookie, or null. Never throws. */
export async function readSessionToken(): Promise<string | null> {
  try {
    const jar = await cookies();
    return jar.get(SESSION_COOKIE)?.value ?? null;
  } catch {
    // No request scope (e.g. during a build). Treat as signed out.
    return null;
  }
}

/**
 * Resolve a raw token to a live session, sliding its expiry forward.
 * Returns null for unknown, expired, or user-less sessions.
 */
export async function resolveSession(token: string | null): Promise<Session | null> {
  if (!token) return null;
  const tokenHash = hashToken(token);

  const rows = await db
    .select({ session: sessions, userActive: users.isActive })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())))
    .limit(1);

  const found = rows[0];
  if (!found) return null;
  if (!found.userActive) {
    // Deactivated user: drop the sessions rather than leaving them usable.
    await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
    return null;
  }

  return found.session;
}

/** Destroy a single session (sign out of this browser). */
export async function destroySession(token: string | null): Promise<void> {
  if (!token) return;
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

/** Destroy every session for a user (password change, force sign-out). */
export async function destroyAllUserSessions(userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

/** Remove expired rows. Cheap enough to call opportunistically. */
export async function purgeExpiredSessions(): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date()))
    .returning({ id: sessions.id });
  return deleted.length;
}

/** Keep an active session alive without changing its identity. */
export async function touchSession(id: string): Promise<void> {
  await db
    .update(sessions)
    .set({ expiresAt: new Date(Date.now() + sessionTtlMs()) })
    .where(eq(sessions.id, id));
}
