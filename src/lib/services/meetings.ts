import { db } from '../db';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Actor } from '../api';
import { ApiError } from '../api';
import type { Meeting, Lead } from '../db/schema';
import { meetings, leadActivities, leads } from '../db/schema';
import { meetingCreateSchema, meetingUpdateSchema } from '../validators';
import { canAccessLead, changeStatus } from './leads';
import { runAutomations } from './automation';
import { resolveVisibleUserIds } from '../api';
import { writeAudit } from '../audit';

export interface MeetingListFilters {
  type: 'MEETING' | 'SITE_VISIT' | 'ALL';
  status?: string;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}

export type MeetingWithExtras = Meeting & {
  leadName: string | null;
  leadNo: string | null;
  contactName: string | null;
  projectName: string | null;
  assigneeName: string | null;
};

const WITH = {
  lead: { columns: { id: true, name: true, leadNo: true } },
  customer: { columns: { id: true, name: true, phone: true } },
  project: { columns: { id: true, name: true } },
  assignee: { columns: { id: true, name: true } },
} as const;

export async function listMeetings(actor: Actor, f: MeetingListFilters): Promise<{ items: MeetingWithExtras[]; total: number }> {
  const ownerIds = await resolveVisibleUserIds(actor.user);
  const conds: any[] = [];
  if (ownerIds) conds.push(inArray(meetings.assignedTo, ownerIds));
  if (f.type !== 'ALL') conds.push(eq(meetings.type, f.type));
  if (f.status) conds.push(eq(meetings.status, f.status));
  if (f.from) conds.push(sql`${meetings.scheduledAt} >= ${new Date(f.from)}`);
  if (f.to) conds.push(sql`${meetings.scheduledAt} <= ${new Date(f.to)}`);

  const where = conds.length ? and(...conds) : undefined;
  const rows = await db.query.meetings.findMany({
    where,
    with: WITH,
    orderBy: [asc(meetings.scheduledAt)],
    limit: f.pageSize,
    offset: (f.page - 1) * f.pageSize,
  });
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(meetings).where(where ?? sql`true`);

  return {
    items: rows.map((r) => {
      const { lead, customer, project, assignee, ...rest } = r;
      return {
        ...(rest as unknown as Meeting),
        leadName: lead?.name ?? null,
        leadNo: lead?.leadNo ?? null,
        contactName: customer?.name ?? lead?.name ?? null,
        projectName: project?.name ?? null,
        assigneeName: assignee?.name ?? null,
      } as MeetingWithExtras;
    }),
    total: count,
  };
}

export async function createMeeting(actor: Actor, rawData: unknown): Promise<Meeting> {
  const data = meetingCreateSchema.parse(rawData);
  if (data.leadId) {
    const canAccess = await canAccessLead(actor, data.leadId);
    if (!canAccess) throw new ApiError(404, 'Lead not found');
  }

  const scheduledAt = data.scheduledAt instanceof Date ? data.scheduledAt : new Date(data.scheduledAt);
  const [created] = await db
    .insert(meetings)
    .values({
      leadId: data.leadId ?? null,
      customerId: data.customerId ?? null,
      projectId: data.projectId ?? null,
      type: data.type,
      visitNumber: data.visitNumber ?? null,
      title: data.title ?? null,
      scheduledAt,
      status: data.status,
      location: data.location ?? null,
      notes: data.notes ?? null,
      assignedTo: data.assignedTo ?? actor.user.id,
      createdById: actor.user.id,
    })
    .returning();

  if (data.leadId) {
    const typeLabel = data.type === 'SITE_VISIT' ? `Site visit #${data.visitNumber ?? 1}` : 'Meeting';
    await db.insert(leadActivities).values({
      leadId: data.leadId,
      type: data.type === 'SITE_VISIT' ? 'SITE_VISIT' : 'MEETING',
      note: `${typeLabel} created: ${scheduledAt.toISOString()}`,
      performedById: actor.user.id,
      meta: { meetingId: created.id, status: data.status, visitNumber: data.visitNumber ?? null },
    });
  }
  await writeAudit({ actor, action: 'CREATE', entity: data.type === 'SITE_VISIT' ? 'visit' : 'meeting', entityId: created.id });
  return created;
}

export async function updateMeeting(actor: Actor, id: string, rawData: unknown): Promise<Meeting | null> {
  const data = meetingUpdateSchema.parse(rawData);
  const existing = await db.query.meetings.findFirst({ where: eq(meetings.id, id) });
  if (!existing) throw new ApiError(404, 'Meeting not found');

  const patch: Record<string, unknown> = {};
  if (data.scheduledAt !== undefined) patch.scheduledAt = data.scheduledAt instanceof Date ? data.scheduledAt : new Date(data.scheduledAt);
  if (data.status !== undefined) patch.status = data.status;
  if (data.location !== undefined) patch.location = data.location ?? null;
  if (data.title !== undefined) patch.title = data.title ?? null;
  if (data.notes !== undefined) patch.notes = data.notes ?? null;
  if (data.feedback !== undefined) patch.feedback = data.feedback ?? null;
  if (data.nextAction !== undefined) patch.nextAction = data.nextAction ?? null;
  if (data.assignedTo !== undefined) patch.assignedTo = data.assignedTo;

  const [updated] = await db.update(meetings).set({ ...patch, updatedAt: new Date() }).where(eq(meetings.id, id)).returning();

  // status change side effects: site visit completion advances the pipeline
  if (data.status === 'COMPLETED' && existing.type === 'SITE_VISIT' && existing.leadId) {
    await handleCompletedVisit(actor, updated ?? existing, existing.leadId);
  }
  await writeAudit({ actor, action: 'UPDATE', entity: 'meeting', entityId: id, newValue: patch });
  return updated ?? null;
}

/** After a site visit is completed: advance lead pipeline + run automation. */
async function handleCompletedVisit(actor: Actor, visit: Meeting, leadId: string): Promise<void> {
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, leadId) });
  if (!lead) return;
  const visitNo = visit.visitNumber ?? 1;

  const nextStatus =
    visitNo === 1
      ? 'SITE_VISIT_2'
      : visitNo === 2
        ? 'SITE_VISIT_3'
        : visitNo === 3
          ? 'NEGOTIATION'
          : undefined;
  if (nextStatus) {
    try {
      await changeStatus(actor, leadId, {
        status: nextStatus,
        reason: `Auto-advanced after Site Visit #${visitNo} completed`,
      });
    } catch {
      // ignore transition errors (already later in pipeline)
    }
  }
  await runAutomations('VISIT_COMPLETED', { leadId, meetingId: visit.id, visitNumber: visitNo }, actor).catch(() => null);
}

export async function setMeetingStatus(
  actor: Actor,
  id: string,
  status: string,
  extras?: { feedback?: string; nextAction?: string },
): Promise<Meeting | null> {
  const existing = await db.query.meetings.findFirst({ where: eq(meetings.id, id) });
  if (!existing) throw new ApiError(404, 'Meeting not found');
  const patch: Record<string, unknown> = { status, updatedAt: new Date() };
  if (extras?.feedback) patch.feedback = extras.feedback;
  if (extras?.nextAction) patch.nextAction = extras.nextAction;
  const [updated] = await db.update(meetings).set(patch).where(eq(meetings.id, id)).returning();
  if (status === 'COMPLETED' && existing.type === 'SITE_VISIT' && existing.leadId) {
    await handleCompletedVisit(actor, updated ?? existing, existing.leadId);
  }
  await writeAudit({ actor, action: 'UPDATE', entity: 'meeting', entityId: id, newValue: { status } });
  return updated ?? null;
}

export async function deleteMeeting(actor: Actor, id: string): Promise<void> {
  await db.delete(meetings).where(eq(meetings.id, id));
  await writeAudit({ actor, action: 'DELETE', entity: 'meeting', entityId: id });
}