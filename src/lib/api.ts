import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser, type CurrentUser } from './auth';
import { type Permission, ROLE_PERMISSIONS, Role, ROLE_LEVEL } from './constants';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
  }
}

export function json<T>(data: T, status = 200, extra?: HeadersInit): NextResponse<T> {
  return NextResponse.json(data, { status, headers: extra });
}

export function error(status: number, message: string, code?: string): NextResponse {
  return NextResponse.json({ error: { message, code } }, { status });
}

export async function readJson<T = unknown>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new ApiError(400, 'Invalid JSON body');
  }
}

export function getParam(params: Record<string, string | string[] | undefined>, key: string): string {
  const v = params[key];
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

export interface Actor {
  user: CurrentUser;
  ip: string | null;
  userAgent: string | null;
  path: string;
  method: string;
}

/** Client IP and user agent, as recorded on audit rows and sessions. */
export function requestMeta(req: NextRequest): { ip: string | null; userAgent: string | null } {
  return {
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || null,
    userAgent: req.headers.get('user-agent'),
  };
}

/** Resolve the authenticated actor + request metadata. Throws 401. */
export async function requireUser(req: NextRequest): Promise<Actor> {
  const user = await getCurrentUser();
  if (!user) throw new ApiError(401, 'Authentication required');
  const meta = requestMeta(req);
  return {
    user,
    ip: meta.ip,
    userAgent: meta.userAgent,
    path: req.nextUrl.pathname,
    method: req.method,
  };
}

/** Resolve the current user without throwing (used by pages). */
export async function currentUserOrNull(): Promise<CurrentUser | null> {
  return getCurrentUser();
}

export function hasPermission(user: CurrentUser, perm: Permission): boolean {
  return user.isSuperAdmin || user.permissions.includes(perm);
}

export function requirePermission(user: CurrentUser, perm: Permission): void {
  if (!hasPermission(user, perm)) {
    throw new ApiError(403, `Permission denied: ${perm}`, 'FORBIDDEN');
  }
}

/**
 * Pass when the user holds at least one of `perms`. Used where a read is
 * legitimately available to a narrower permission than the write it feeds
 * (e.g. picking a project for a site visit needs `projects.view`, while
 * creating or editing one needs `projects.manage`).
 */
export function hasAnyPermission(user: CurrentUser, perms: Permission[]): boolean {
  return user.isSuperAdmin || perms.some((p) => user.permissions.includes(p));
}

export function requireAnyPermission(user: CurrentUser, perms: Permission[]): void {
  if (!hasAnyPermission(user, perms)) {
    throw new ApiError(403, `Permission denied: ${perms.join(' or ')}`, 'FORBIDDEN');
  }
}

export function isRoleAbove(actor: CurrentUser, otherRole: Role): boolean {
  return ROLE_LEVEL[actor.role] >= ROLE_LEVEL[otherRole];
}

/** Build a scoped NOT-IN / IN clause for resource ownership. */
export type Scope = { all: boolean; userIds: string[] };

export function getUserScope(user: CurrentUser): Scope {
  switch (user.role) {
    case 'SUPER_ADMIN':
    case 'ADMIN':
    case 'SALES_MANAGER':
    case 'ACCOUNTS':
    case 'DOCUMENT_MANAGER':
    case 'VIEW_ONLY':
      return { all: true, userIds: [] };
    case 'TEAM_LEADER':
      // team leader sees own records + direct reports
      return {
        all: false,
        userIds: [], // populated dynamically via query on users table
        // (see describeScope) 
      };
    case 'SALES_EXECUTIVE':
      return { all: false, userIds: [user.id] };
  }
  return { all: false, userIds: [] };
}

/**
 * Returns a SQL condition or list of owner ids a user may see.
 * Executives: own records. Team leaders: own + direct reports.
 * Managers and above: everything.
 */
export async function resolveVisibleUserIds(user: CurrentUser): Promise<string[] | null> {
  const scope = getUserScope(user);
  if (scope.all) return null; // null = no filter
  if (user.role === 'TEAM_LEADER') {
    const { users } = await import('./db/schema');
    const { db } = await import('./db');
    const reports = await db.query.users.findMany({
      where: (u, { eq }) => eq(u.managerId, user.id),
      columns: { id: true },
    });
    return [user.id, ...reports.map((r) => r.id)];
  }
  return scope.userIds;
}

export function validate<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new ApiError(
      422,
      `${first?.path?.join('.') ?? 'field'}: ${first?.message ?? 'Invalid value'}`,
      'VALIDATION',
    );
  }
  return result.data;
}

/** Parse and clamp common list query params. */
export function pagination(searchParams: URLSearchParams) {
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') ?? '20', 10) || 20));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function parseBool(v: string | null): boolean | undefined {
  if (v === null) return undefined;
  return v === 'true';
}