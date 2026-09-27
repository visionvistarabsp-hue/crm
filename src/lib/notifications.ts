import { db } from './db';
import { notifications, users } from './db/schema';
import { inArray, isNull } from 'drizzle-orm';
import { enqueueJob } from './queue';

export interface NotifyArgs {
  type: string;
  title: string;
  body?: string;
  entityType?: string;
  entityId?: string;
  meta?: Record<string, unknown>;
}

/** Insert an in-app notification for one user. */
export async function notifyUser(userId: string, args: NotifyArgs): Promise<void> {
  try {
    await db.insert(notifications).values({
      userId,
      type: args.type,
      title: args.title,
      body: args.body,
      entityType: args.entityType,
      entityId: args.entityId,
      meta: args.meta,
    });
  } catch {
    /* notifications are best-effort */
  }
}

/** Insert notifications for many users. */
export async function notifyMany(userIds: string[], args: NotifyArgs): Promise<void> {
  if (!userIds.length) return;
  try {
    await db.insert(notifications).values(userIds.map((userId) => ({ userId, ...args }))).onConflictDoNothing();
  } catch {
    /* best-effort */
  }
}

/** Notify an entire sales team (all active sales users). */
export async function notifyTeam(args: NotifyArgs): Promise<void> {
  try {
    const team = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.role, ['SALES_EXECUTIVE', 'TEAM_LEADER', 'SALES_MANAGER']));
    await notifyMany(team.map((u) => u.id), args);
  } catch {
    /* best-effort */
  }
}

export interface ReminderPayload {
  followupId: string;
  leadName?: string;
  userId: string;
  scheduledAt: string;
}

/** Enqueue a follow-up reminder that will fire an in-app notification at the right time. */
export async function scheduleFollowupReminder(p: ReminderPayload): Promise<void> {
  const at = new Date(p.scheduledAt);
  if (isNaN(at.getTime())) return;
  await enqueueJob('REMINDER', p as unknown as Record<string, unknown>, { runAt: at, priority: 2 });
}

export async function registerReminderHandler(): Promise<void> {
  const { registerJobHandler } = await import('./queue');
  registerJobHandler('REMINDER', async (payload) => {
    const p = payload as unknown as ReminderPayload;
    await notifyUser(p.userId, {
      type: 'FOLLOWUP_REMINDER',
      title: 'Follow-up reminder',
      body: `Scheduled follow-up with ${p.leadName ?? 'lead'} is due now.`,
      entityType: 'followup',
      entityId: p.followupId,
    });
  });

  registerJobHandler('NOTIFY', async (payload) => {
    const data = payload as unknown as NotifyArgs & { userId: string; userIds?: string[] };
    if (data.userIds?.length) await notifyMany(data.userIds, { ...data });
    else if (data.userId) await notifyUser(data.userId, { ...data });
  });
}