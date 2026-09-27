import { db } from '../db';
import { users } from '../db/schema';
import { asc, eq, inArray } from 'drizzle-orm';
import type { CurrentUser } from '../auth';
import { ApiError } from '../api';
import { ROLES, type Role, ROLE_LEVEL } from '../constants';
import { resolveVisibleUserIds } from '../api';

export type TeamMember = typeof users.$inferSelect;

const ASSIGNABLE_ROLES: Role[] = ['SALES_EXECUTIVE', 'TEAM_LEADER'];

export async function listAssignableUsers(): Promise<TeamMember[]> {
  return db.query.users.findMany({
    where: (u, { and, eq, inArray }) =>
      and(eq(u.isActive, true), inArray(u.role, ASSIGNABLE_ROLES)),
    orderBy: (u, { asc }) => asc(u.name),
  });
}

export async function listTeam(): Promise<Array<TeamMember & { managerName: string | null }>> {
  const rows = await db.select().from(users).orderBy(asc(users.name));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return rows.map((r) => ({
    ...r,
    managerName: r.managerId ? byId.get(r.managerId)?.name ?? null : null,
  }));
}

export async function getUserById(id: string): Promise<TeamMember | null> {
  const found = await (db.query.users as any).findFirst({ where: eq(users.id, id) });
  return found ?? null;
}

/** Ensure a target user is a valid assignment target. */
export async function assertAssignableTarget(
  actor: CurrentUser,
  targetId: string,
): Promise<TeamMember> {
  const target = await getUserById(targetId);
  if (!target || !target.isActive) throw new ApiError(422, 'Assignee is not active');
  const roleOk = ASSIGNABLE_ROLES.includes(target.role as Role);
  if (!roleOk && actor.role !== 'SUPER_ADMIN' && actor.role !== 'ADMIN') {
    throw new ApiError(422, 'Target is not assignable');
  }
  // team leaders can only assign within their own team
  if (actor.role === 'TEAM_LEADER' && target.managerId !== actor.id && target.id !== actor.id) {
    throw new ApiError(403, 'Can only assign within your team');
  }
  return target;
}

export async function canManageUser(actor: CurrentUser, target: TeamMember): Promise<boolean> {
  if (actor.role === 'SUPER_ADMIN') return true;
  if (actor.role === 'ADMIN') return ROLE_LEVEL[target.role as Role] < ROLE_LEVEL.ADMIN;
  if (actor.role === 'SALES_MANAGER') {
    return ['SALES_EXECUTIVE', 'TEAM_LEADER'].includes(target.role);
  }
  return false;
}

export { resolveVisibleUserIds, ROLES };