import { and, eq, sql } from 'drizzle-orm';
import { db } from './db';
import { users, type User } from './db/schema';
import { ROLES, ROLE_PERMISSIONS, type Role } from './constants';
import { ApiError } from './api';
import { hashPassword, verifyPassword, checkPasswordPolicy } from './password';
import {
  createSession,
  destroySession,
  purgeExpiredSessions,
  readSessionToken,
  resolveSession,
  sessionTtlMs,
  touchSession,
} from './session';

/**
 * Session-based authentication against our own `users` table.
 *
 * The identity is the email + password pair; the session is an opaque token in
 * an httpOnly cookie backed by the `sessions` table (see ./session.ts). There is
 * no external identity provider — the middleware only checks that the cookie is
 * present, and everything below is the authoritative check.
 */

/** The subset of the user row the app is allowed to see. */
export type CurrentUser = {
  id: string;
  name: string;
  email: string;
  role: Role;
  permissions: string[];
  isSuperAdmin: boolean;
};

export const DEMO_EMAIL = 'demo@salespoint.in';

/**
 * Escape hatch for local UI work. Off unless AUTH_DEMO_MODE=true, and it never
 * creates a real session — it only short-circuits the current-user lookup.
 */
export function isDemoMode(): boolean {
  return process.env.AUTH_DEMO_MODE === 'true';
}

/** Synthetic actor used when AUTH_DEMO_MODE=true. Exported for the webhook actor. */
export const demoUser: CurrentUser = (() => {
  const role = ROLES[0]!;
  return {
    id: 'demo',
    name: 'Demo Admin',
    email: DEMO_EMAIL,
    role,
    permissions: ROLE_PERMISSIONS[role] ?? [],
    isSuperAdmin: role === 'SUPER_ADMIN',
  };
})();

function toCurrentUser(row: Pick<User, 'id' | 'name' | 'email' | 'role'>): CurrentUser {
  const role = (ROLES as readonly string[]).includes(row.role)
    ? (row.role as Role)
    : ROLES[ROLES.length - 1]!;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role,
    permissions: ROLE_PERMISSIONS[role] ?? [],
    isSuperAdmin: role === 'SUPER_ADMIN',
  };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Find a user by email, case-insensitively (matches users_email_lower_key). */
export async function findUserByEmail(email: string): Promise<User | null> {
  const needle = normalizeEmail(email);
  if (!needle) return null;
  const rows = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${needle}`)
    .limit(1);
  return rows[0] ?? null;
}

export async function findUserById(id: string): Promise<User | null> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0] ?? null;
}

// ------------------------------------------------------------------
// Authentication
// ------------------------------------------------------------------

export type AuthFailure = 'invalid_credentials' | 'inactive' | 'no_password';

export type AuthResult =
  | { ok: true; user: User }
  | { ok: false; reason: AuthFailure };

/**
 * Verify a password against a stored user row. A missing account and a wrong
 * password are reported identically so the endpoint cannot be used to enumerate
 * registered addresses.
 */
export async function authenticate(email: string, password: string): Promise<AuthResult> {
  const user = await findUserByEmail(email);
  if (!user) {
    // Equalise timing against the "user exists, wrong password" path.
    await verifyPassword(password, null);
    return { ok: false, reason: 'invalid_credentials' };
  }
  if (!user.isActive) return { ok: false, reason: 'inactive' };
  if (!user.passwordHash) {
    // Service accounts (e.g. the Meta webhook bot) have no password and can
    // never authenticate interactively.
    await verifyPassword(password, null);
    return { ok: false, reason: 'no_password' };
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) return { ok: false, reason: 'invalid_credentials' };
  return { ok: true, user };
}

export type RegisterInput = {
  name: string;
  email: string;
  password: string;
  phone?: string | null;
  role?: Role;
};

/**
 * Create a new account. Throws ApiError(422) with a field-level message so the
 * signup form can render it directly.
 */
export async function registerUser(input: RegisterInput): Promise<User> {
  const name = input.name.trim();
  const email = normalizeEmail(input.email);

  if (name.length < 2) throw new ApiError(422, 'Name must be at least 2 characters', 'INVALID_NAME');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(422, 'Enter a valid email address', 'INVALID_EMAIL');
  }
  const policy = checkPasswordPolicy(input.password);
  if (policy) throw new ApiError(422, policy, 'WEAK_PASSWORD');

  const role = input.role && (ROLES as readonly string[]).includes(input.role) ? input.role : 'SALES_EXECUTIVE';

  const existing = await findUserByEmail(email);
  if (existing) {
    throw new ApiError(409, 'An account with that email already exists', 'EMAIL_TAKEN');
  }

  const passwordHash = await hashPassword(input.password);
  const rows = await db
    .insert(users)
    .values({ name, email, passwordHash, role, phone: input.phone ?? null })
    .onConflictDoNothing()
    .returning();

  const created = rows[0];
  if (!created) {
    // Lost the race against a concurrent signup for the same address.
    throw new ApiError(409, 'An account with that email already exists', 'EMAIL_TAKEN');
  }
  return created;
}

// ------------------------------------------------------------------
// Session lifecycle
// ------------------------------------------------------------------

export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/** Sign in: verify credentials, then create the session row. Returns the token. */
export async function login(
  email: string,
  password: string,
  meta: RequestMeta = {},
): Promise<{ token: string; maxAgeSeconds: number; user: CurrentUser }> {
  const result = await authenticate(email, password);
  if (!result.ok) {
    const message =
      result.reason === 'inactive'
        ? 'This account has been deactivated'
        : 'Invalid email or password';
    throw new ApiError(
      401,
      message,
      result.reason === 'inactive' ? 'ACCOUNT_INACTIVE' : 'INVALID_CREDENTIALS',
    );
  }

  const session = await createSession(result.user.id, meta);
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, result.user.id));

  // Opportunistic cleanup so the sessions table does not grow without bound.
  await purgeExpiredSessions().catch(() => undefined);

  return {
    token: session.token,
    maxAgeSeconds: session.maxAgeSeconds,
    user: toCurrentUser(result.user),
  };
}

/** Sign in a freshly created account, so signup lands the user already signed in. */
export async function registerAndLogin(
  input: RegisterInput,
  meta: RequestMeta = {},
): Promise<{ token: string; maxAgeSeconds: number; user: CurrentUser }> {
  const user = await registerUser(input);
  return login(user.email, input.password, meta);
}

/** Sign out: delete the session row for the current cookie and clear the cookie. */
export async function logout(): Promise<void> {
  const token = await readSessionToken();
  if (token) await destroySession(token);
}

// ------------------------------------------------------------------
// Current-user resolution
// ------------------------------------------------------------------

/**
 * The authenticated user for this request, or null.
 *
 * Resolves the cookie to a session row and returns the *live* user record, so
 * role changes and deactivation apply immediately. Only meant for the Node
 * runtime (it touches the database).
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  if (isDemoMode()) return demoUser;

  const token = await readSessionToken();
  if (!token) return null;

  const session = await resolveSession(token);
  if (!session) return null;

  const row = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      isActive: users.isActive,
    })
    .from(users)
    .where(and(eq(users.id, session.userId), eq(users.isActive, true)))
    .limit(1);

  const user = row[0];
  if (!user) return null;

  // Sliding expiry: only worth a write for sessions well inside their window.
  const remainingMs = session.expiresAt.getTime() - Date.now();
  if (remainingMs < sessionTtlMs() / 2) {
    await touchSession(session.id).catch(() => undefined);
  }

  return toCurrentUser(user);
}

/** Like getCurrentUser, but throws 401 instead of returning null. */
export async function requireUserOrThrow(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new ApiError(401, 'Authentication required', 'UNAUTHENTICATED');
  return user;
}
