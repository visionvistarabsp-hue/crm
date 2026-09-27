import { db } from '../db';
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Actor } from '../api';
import { ApiError } from '../api';
import type { Followup } from '../db/schema';
import { followups, leadActivities, leads } from '../db/schema';
import { followupCreateSchema, followupUpdateSchema, followupCompleteSchema } from '../validators';
import { scheduleFollowupReminder } from '../notifications';
import { runAutomations } from './automation';
import { startOfDay, endOfDay, addDays } from '../utils';
import { canAccessLead } from './leads';
import { resolveVisibleUserIds } from '../api';
import { writeAudit } from '../audit';

export type FollowupView = 'today' | 'upcoming' | 'overdue' | 'done' | 'all';

export interface FollowupListFilters {
  view: FollowupView;
  assignedTo?: string;
  leadId?: string;
  customerId?: string;
  page: number;
  pageSize: number;
}

export type FollowupWithExtras = Followup & {
  leadName: string | null;
  leadNo: string | null;
  contactName: string | null;
  contactPhone: string | null;
  assigneeName: string | null;
};

const WITH = {
  lead: { columns: { id: true, name: true, leadNo: true } },
  customer: { columns: { id: true, name: true, phone: true } },
  assignee: { columns: { id: true, name: true } },
} as const;

export async function listFollowups(actor: Actor, f: FollowupListFilters): Promise<{ items: FollowupWithExtras[]; total: number }> {
  const ownerIds = await resolveVisibleUserIds(actor.user);
  const conds: any[] = [];
  const now = new Date();
  const todayStart = startOfDay();
  const todayEnd = endOfDay();

  if (ownerIds) conds.push(inArray(followups.assignedTo, ownerIds));
  if (f.assignedTo) conds.push(eq(followups.assignedTo, f.assignedTo));
  if (f.leadId) conds.push(eq(followups.leadId, f.leadId));
  if (f.customerId) conds.push(eq(followups.customerId, f.customerId));

  switch (f.view) {
    case 'today':
      conds.push(eq(followups.status, 'PENDING'), and(gte(followups.scheduledAt, todayStart), lte(followups.scheduledAt, todayEnd)));
      break;
    case 'upcoming':
      conds.push(eq(followups.status, 'PENDING'), gte(followups.scheduledAt, todayEnd));
      break;
    case 'overdue':
      conds.push(eq(followups.status, 'PENDING'), lte(followups.scheduledAt, now));
      break;
    case 'done':
      conds.push(eq(followups.status, 'COMPLETED'));
      break;
    case 'all':
      break;
  }

  // roll overdue statuses to EXPIRED
  if (f.view === 'overdue') {
    await db.update(followups).set({ status: 'EXPIRED' }).where(and(eq(followups.status, 'PENDING'), lte(followups.scheduledAt, now)));
    void 0;
  }

  const where = conds.length ? and(...conds) : undefined;
  const rows = await db.query.followups.findMany({
    where,
    with: WITH,
    orderBy: [asc(followups.scheduledAt)],
    limit: f.pageSize,
    offset: (f.page - 1) * f.pageSize,
  });
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(followups).where(where ?? sql`true`);

  return {
    items: rows.map((r) => {
      const { lead, customer, assignee, ...rest } = r;
      return {
        ...(rest as unknown as Followup),
        leadName: lead?.name ?? null,
        leadNo: lead?.leadNo ?? null,
        contactName: customer?.name ?? lead?.name ?? null,
        contactPhone: customer?.phone ?? null,
        assigneeName: assignee?.name ?? null,
      } as FollowupWithExtras;
    }),
    total: count,
  };
}

export async function createFollowup(actor: Actor, rawData: unknown): Promise<Followup> {
  const data = followupCreateSchema.parse(rawData);
  if (data.leadId) {
    const canAccess = await canAccessLead(actor, data.leadId);
    if (!canAccess) throw new ApiError(404, 'Lead not found');
  }

  const scheduledAt = data.scheduledAt instanceof Date ? data.scheduledAt : new Date(data.scheduledAt);
  const reminderAt = data.reminderAt
    ? data.reminderAt instanceof Date
      ? data.reminderAt
      : new Date(data.reminderAt)
    : scheduledAt;

  const [created] = await db
    .insert(followups)
    .values({
      leadId: data.leadId ?? null,
      customerId: data.customerId ?? null,
      type: data.type,
      scheduledAt,
      reminderAt,
      notes: data.notes ?? null,
      assignedTo: data.assignedTo ?? actor.user.id,
      createdById: actor.user.id,
      remindBeforeMinutes: data.remindBeforeMinutes ?? 60,
    })
    .returning();

  if (data.leadId) {
    await db.insert(leadActivities).values({
      leadId: data.leadId,
      type: 'FOLLOWUP_CREATED',
      note: `Follow-up scheduled (${data.type}) at ${scheduledAt.toISOString()}`,
      performedById: actor.user.id,
      meta: { followupId: created.id, type: data.type },
    });
  }
  await scheduleFollowupReminder({
    followupId: created.id,
    userId: created.assignedTo ?? actor.user.id,
    scheduledAt: reminderAt.toISOString(),
    leadName: undefined,
  });
  await writeAudit({ actor, action: 'CREATE', entity: 'followup', entityId: created.id });

  if (data.leadId) await runAutomations('FOLLOWUP_DONE', { leadId: data.leadId, followupId: created.id, followupStatus: 'SCHEDULED' }, actor).catch(() => null);
  return created;
}

export async function updateFollowup(actor: Actor, id: string, rawData: unknown): Promise<Followup | null> {
  const data = followupUpdateSchema.parse(rawData);
  const existing = await db.query.followups.findFirst({ where: eq(followups.id, id) });
  if (!existing) throw new ApiError(404, 'Follow-up not found');

  const patch: Record<string, unknown> = {};
  if (data.scheduledAt !== undefined) patch.scheduledAt = data.scheduledAt instanceof Date ? data.scheduledAt : new Date(data.scheduledAt);
  if (data.reminderAt !== undefined) patch.reminderAt = data.reminderAt instanceof Date ? data.reminderAt : new Date(data.reminderAt);
  if (data.type !== undefined) patch.type = data.type;
  if (data.notes !== undefined) patch.notes = data.notes ?? null;
  if (data.assignedTo !== undefined) patch.assignedTo = data.assignedTo;

  const [updated] = await db.update(followups).set({ ...patch, updatedAt: new Date() }).where(eq(followups.id, id)).returning();
  await writeAudit({ actor, action: 'UPDATE', entity: 'followup', entityId: id });
  return updated ?? null;
}

export async function completeFollowup(actor: Actor, id: string, rawData: unknown): Promise<{ updated: Followup | null; nextFollowup: Followup | null }> {
  const data = followupCompleteSchema.parse(rawData);
  const existing = await db.query.followups.findFirst({ where: eq(followups.id, id) });
  if (!existing) throw new ApiError(404, 'Follow-up not found');

  const [updated] = await db
    .update(followups)
    .set({ status: 'COMPLETED', completedAt: new Date(), completedById: actor.user.id, notes: data.outcome ? existing.notes ? `${existing.notes}\n${data.outcome}` : data.outcome : existing.notes, updatedAt: new Date() })
    .where(eq(followups.id, id))
    .returning();

  let nextFollowup: Followup | null = null;
  if (data.nextFollowupAt) {
    const planned = data.nextFollowupAt instanceof Date ? data.nextFollowupAt : new Date(data.nextFollowupAt);
    const [nf] = await db
      .insert(followups)
      .values({
        leadId: existing.leadId,
        customerId: existing.customerId,
        type: data.nextFollowupType ?? 'CALL',
        scheduledAt: planned,
        reminderAt: planned,
        notes: data.nextFollowupNote ?? 'Next follow-up created after completion',
        assignedTo: existing.assignedTo,
        createdById: actor.user.id,
      })
      .returning();
    nextFollowup = nf;
    await db.update(followups).set({ nextFollowupId: nf.id, updatedAt: new Date() }).where(eq(followups.id, id));
    await scheduleFollowupReminder({ followupId: nf.id, userId: nf.assignedTo ?? actor.user.id, scheduledAt: planned.toISOString(), leadName: undefined });
  }

  if (existing.leadId) {
    await db.insert(leadActivities).values({
      leadId: existing.leadId,
      type: 'FOLLOWUP_CREATED',
      note: `Follow-up completed (${existing.type})${data.outcome ? ` — ${data.outcome}` : ''}`,
      performedById: actor.user.id,
      meta: { followupId: id, status: 'COMPLETED' },
    });
    await runAutomations('FOLLOWUP_DONE', { leadId: existing.leadId, followupId: id, followupStatus: 'COMPLETED' }, actor).catch(() => null);
  }
  await writeAudit({ actor, action: 'UPDATE', entity: 'followup', entityId: id, newValue: { status: 'COMPLETED' } });
  return { updated: updated ?? null, nextFollowup };
}

export async function deleteFollowup(actor: Actor, id: string): Promise<void> {
  await db.delete(followups).where(eq(followups.id, id));
  await writeAudit({ actor, action: 'DELETE', entity: 'followup', entityId: id });
}

/** Backfill overdue state (invoked opportunistically). */
export async function markOverdueFollowups(): Promise<number> {
  const res = await db
    .update(followups)
    .set({ status: 'EXPIRED', updatedAt: new Date() })
    .where(and(eq(followups.status, 'PENDING'), lte(followups.scheduledAt, new Date())));
  return res.rowCount ?? 0;
}

export { addDays };