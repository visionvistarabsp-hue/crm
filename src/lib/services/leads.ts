import { db } from '../db';
import { and, asc, desc, eq, gte, lte, or, ilike, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Actor } from '../api';
import { ApiError } from '../api';
import type { Lead, LeadInsert } from '../db/schema';
import {
  leadActivities,
  leadStatusHistory,
  leadDuplicates,
  leadAssignments,
  leads,
  followups,
  meetings,
} from '../db/schema';
import { nextNumber } from './counters';
import { normalizePhone, normalizeEmail } from '../utils';
import { createLeadSchema, updateLeadSchema, statusChangeSchema, activityCreateSchema } from '../validators';
import { validateStatusChange, canReopen } from './statusMachine';
import { resolveVisibleUserIds } from '../api';
import { writeAudit } from '../audit';
import { assignLead } from './assignment';
import { runAutomations } from './automation';
import { notifyUser } from '../notifications';
import { ACTIVITY_TYPES, LEAD_SOURCES, type LeadStatus } from '../constants';

export interface LeadListFilters {
  status?: string;
  source?: string;
  priority?: string;
  projectId?: string;
  ownerFilter?: 'mine' | 'unassigned' | 'all';
  search?: string;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}

export interface LeadWithExtras extends Lead {
  ownerName: string | null;
  projectName: string | null;
  nextFollowupAt: Date | null;
  activities?: unknown[];
  statusHistory?: unknown[];
  followupsList?: unknown[];
}

const LEAD_SELECT = {
  id: true, leadNo: true, name: true, phone: true, whatsapp: true, email: true,
  source: true, campaign: true, adName: true, projectId: true, budget: true,
  preferredLocation: true, propertyType: true, requirement: true, ownerId: true,
  priority: true, status: true, tags: true, isDuplicate: true, duplicateOfId: true,
  notes: true, sourceRef: true, metadata: true, createdById: true, firstSeenAt: true,
  createdAt: true, updatedAt: true, assignedAt: true,
} as const;

const OPEN_STATUS_SET = ['NEW','CONTACT_PENDING','CONTACTED','QUALIFIED','FOLLOW_UP','MEETING','SITE_VISIT_1','SITE_VISIT_2','SITE_VISIT_3','NEGOTIATION','BOOKING','DOCUMENT_COLLECTION'];
const CLOSED_STATUS_SET = ['DEAL_COMPLETED','NOT_INTERESTED','CALL_BACK_LATER','WRONG_NUMBER','DUPLICATE','LOST','CANCELLED'];

export async function listLeads(actor: Actor, filters: LeadListFilters): Promise<{ items: LeadWithExtras[]; total: number }> {
  const ownerIds = await resolveVisibleUserIds(actor.user);
  const conds: ReturnType<typeof eq>[] = [];

  if (ownerIds) {
    if (filters.ownerFilter === 'unassigned') conds.push(isNull(leads.ownerId));
    else conds.push(inArray(leads.ownerId, ownerIds));
  } else {
    if (filters.ownerFilter === 'mine') conds.push(eq(leads.ownerId, actor.user.id));
    else if (filters.ownerFilter === 'unassigned') conds.push(isNull(leads.ownerId));
  }

  if (filters.status) {
    if (filters.status === 'OPEN') conds.push(inArray(leads.status, OPEN_STATUS_SET));
    else if (filters.status === 'CLOSED') conds.push(inArray(leads.status, CLOSED_STATUS_SET));
    else conds.push(eq(leads.status, filters.status));
  }
  if (filters.source) conds.push(eq(leads.source, filters.source));
  if (filters.priority) conds.push(eq(leads.priority, filters.priority));
  if (filters.projectId) conds.push(eq(leads.projectId, filters.projectId));
  if (filters.from) conds.push(gte(leads.createdAt, new Date(filters.from)));
  if (filters.to) conds.push(lte(leads.createdAt, new Date(filters.to)));
  if (filters.search) {
    const q = `%${filters.search}%`;
    conds.push(
      or(ilike(leads.name, q), ilike(leads.phone, q), ilike(leads.email, q), ilike(leads.leadNo, q), ilike(leads.preferredLocation, q))!,
    );
  }

  const where = conds.length ? and(...conds) : undefined;

  const rows = await db.query.leads.findMany({
    where,
    with: { owner: { columns: { id: true, name: true } }, project: { columns: { id: true, name: true } } },
    orderBy: [desc(leads.createdAt)],
    limit: filters.pageSize,
    offset: (filters.page - 1) * filters.pageSize,
  });

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(leads)
    .where(where ?? sql`true`);

  const items: LeadWithExtras[] = rows.map((r) => ({
    ...(r as unknown as Lead),
    ownerName: r.owner?.name ?? null,
    projectName: r.project?.name ?? null,
    nextFollowupAt: null,
  }));

  // attach next pending follow-up times in one query
  if (items.length) {
    const fups = await db
      .select({ leadId: followups.leadId, scheduledAt: followups.scheduledAt })
      .from(followups)
      .where(and(inArray(followups.leadId, items.map((i) => i.id)), eq(followups.status, 'PENDING'), gte(followups.scheduledAt, new Date(0))))
      .orderBy(asc(followups.scheduledAt));
    const firstByLead = new Map<string, Date>();
    for (const f of fups) {
      if (!firstByLead.has(f.leadId!)) firstByLead.set(f.leadId!, f.scheduledAt);
    }
    for (const item of items) item.nextFollowupAt = firstByLead.get(item.id) ?? null;
  }

  return { items, total: count };
}

export async function getLead(actor: Actor, id: string): Promise<LeadWithExtras | null> {
  const canAccess = await canAccessLead(actor, id);
  if (!canAccess) throw new ApiError(404, 'Lead not found');
  const row = await db.query.leads.findFirst({
    where: eq(leads.id, id),
    with: {
      owner: { columns: { id: true, name: true, email: true, phone: true } },
      project: { columns: { id: true, name: true } },
      activities: { orderBy: (a, { desc: d }) => [d(a.createdAt)] },
      statusHistory: { orderBy: (h, { desc: d }) => [d(h.createdAt)] },
      followups: { orderBy: (f, { asc: a }) => [a(f.scheduledAt)] },
    },
  });
  if (!row) return null;

  const next = row.followups.find((f) => f.status === 'PENDING');
  const { activities, statusHistory, followups: fups, owner, project, ...rest } = row;
  return {
    ...(rest as unknown as Lead),
    ownerName: owner?.name ?? null,
    projectName: project?.name ?? null,
    nextFollowupAt: next?.scheduledAt ?? null,
    activities: activities as unknown[],
    statusHistory: statusHistory as unknown[],
    followupsList: fups as unknown[],
  };
}

export async function canAccessLead(actor: Actor, leadId: string): Promise<boolean> {
  const ownerIds = await resolveVisibleUserIds(actor.user);
  if (!ownerIds) return true;
  const row = await db.query.leads.findFirst({ where: eq(leads.id, leadId), columns: { ownerId: true } });
  if (!row) return false;
  if (!row.ownerId) return actor.user.role !== 'SALES_EXECUTIVE';
  return ownerIds.includes(row.ownerId);
}

export async function searchLeads(actor: Actor, q: string, limit = 6): Promise<LeadWithExtras[]> {
  const ownerIds = await resolveVisibleUserIds(actor.user);
  const where = ownerIds
    ? and(inArray(leads.ownerId, ownerIds), or(ilike(leads.name, `%${q}%`), ilike(leads.phone, `%${q}%`), ilike(leads.leadNo, `%${q}%`), ilike(leads.email, `%${q}%`)))
    : or(ilike(leads.name, `%${q}%`), ilike(leads.phone, `%${q}%`), ilike(leads.leadNo, `%${q}%`), ilike(leads.email, `%${q}%`));
  const rows = await db.query.leads.findMany({
    where,
    with: { owner: { columns: { id: true, name: true } } },
    limit,
    orderBy: [desc(leads.createdAt)],
  });
  return rows.map((r) => ({
    ...(r as unknown as Lead),
    ownerName: r.owner?.name ?? null,
    projectName: null,
    nextFollowupAt: null,
  }));
}

export async function findDuplicateLeadsByIdentity(
  identity: { phone?: string | null; whatsapp?: string | null; email?: string | null },
  excludeId?: string,
): Promise<Array<{ lead: { id: string; leadNo: string; name: string; phone: string | null; email: string | null }; rule: string }>> {
  const cPhone = normalizePhone(identity.phone) ?? normalizePhone(identity.whatsapp);
  const cEmail = normalizeEmail(identity.email);
  const conds: any[] = [];
  if (cPhone) conds.push(or(eq(leads.phone, cPhone), eq(leads.whatsapp, cPhone)));
  if (cEmail) conds.push(eq(leads.email, cEmail));
  if (!conds.length) return [];
  if (excludeId) conds.push(ne(leads.id, excludeId));

  const rows = await db.query.leads.findMany({
    where: and(...conds),
    columns: { id: true, leadNo: true, name: true, phone: true, email: true },
    limit: 25,
  });
  return rows.map((r) => ({ lead: r, rule: cEmail && r.email === cEmail ? 'EMAIL' : 'PHONE' }));
}

export async function createLead(
  actor: Actor,
  rawData: unknown,
): Promise<{ lead: Lead; duplicates: Array<{ lead: { id: string; leadNo: string; name: string; phone: string | null; email: string | null }; rule: string }> }> {
  const data = createLeadSchema.parse(rawData);

  const duplicates = await findDuplicateLeadsByIdentity(data);
  const leadNo = await nextNumber('lead', 'LD');

  const insert: LeadInsert = {
    leadNo,
    name: data.name,
    phone: data.phone ? normalizePhone(data.phone) : null,
    whatsapp: data.whatsapp ? normalizePhone(data.whatsapp) ?? data.whatsapp : null,
    email: data.email ? normalizeEmail(data.email) : null,
    source: data.source ?? 'MANUAL',
    campaign: data.campaign ?? null,
    adName: data.adName ?? null,
    projectId: data.projectId ?? null,
    budget: data.budget != null ? String(data.budget) : null,
    preferredLocation: data.preferredLocation ?? null,
    propertyType: data.propertyType ?? null,
    requirement: data.requirement ?? null,
    priority: data.priority ?? 'MEDIUM',
    status: 'NEW',
    tags: data.tags ?? [],
    notes: data.notes ?? null,
    sourceRef: data.sourceRef ?? null,
    isDuplicate: duplicates.length > 0,
    metadata: data.meta ?? {},
    createdById: actor.user.id,
    firstSeenAt: new Date(),
  };

  let created: Lead | undefined;
  await db.transaction(async (tx) => {
    const [c] = await tx.insert(leads).values(insert).returning();
    created = c;
    await tx.insert(leadStatusHistory).values({
      leadId: c.id,
      toStatus: 'NEW',
      changedById: actor.user.id,
      meta: { source: insert.source },
    });
    await tx.insert(leadActivities).values({
      leadId: c.id,
      type: 'NOTE',
      note: `Lead created from ${insert.source}`,
      performedById: actor.user.id,
      meta: { source: insert.source, isDuplicate: insert.isDuplicate },
    });
  });

  if (!created) throw new ApiError(500, 'Failed to create lead');

  if (duplicates.length) {
    for (const d of duplicates) {
      await db.insert(leadDuplicates).values({
        leadId: created.id,
        duplicateOfId: d.lead.id,
        ruleType: d.rule,
        confidence: d.rule === 'EMAIL' ? 100 : 95,
        status: 'OPEN',
      });
    }
  }

  await assignLead({ lead: created, actor, skipIfAssigned: false });
  await runAutomations('LEAD_CREATED', { leadId: created.id }, actor);
  await writeAudit({
    actor,
    action: 'CREATE',
    entity: 'lead',
    entityId: created.id,
    newValue: { leadNo, name: created.name, source: created.source },
  });

  return { lead: created, duplicates };
}

export async function updateLead(actor: Actor, id: string, rawData: unknown): Promise<Lead | null> {
  const canAccess = await canAccessLead(actor, id);
  if (!canAccess) throw new ApiError(404, 'Lead not found');
  const data = updateLeadSchema.parse(rawData);
  const existing = await db.query.leads.findFirst({ where: eq(leads.id, id) });
  if (!existing) throw new ApiError(404, 'Lead not found');

  const patch: Record<string, unknown> = {};
  if (data.name !== undefined) patch.name = data.name;
  if (data.phone !== undefined) patch.phone = data.phone ? normalizePhone(data.phone) : null;
  if (data.whatsapp !== undefined) patch.whatsapp = data.whatsapp ? normalizePhone(data.whatsapp) ?? data.whatsapp : null;
  if (data.email !== undefined) patch.email = data.email ? normalizeEmail(data.email) : null;
  if (data.campaign !== undefined) patch.campaign = data.campaign ?? null;
  if (data.adName !== undefined) patch.adName = data.adName ?? null;
  if (data.projectId !== undefined) patch.projectId = data.projectId ?? null;
  if (data.budget !== undefined) patch.budget = data.budget != null ? String(data.budget) : null;
  if (data.preferredLocation !== undefined) patch.preferredLocation = data.preferredLocation ?? null;
  if (data.propertyType !== undefined) patch.propertyType = data.propertyType ?? null;
  if (data.requirement !== undefined) patch.requirement = data.requirement ?? null;
  if (data.priority !== undefined) patch.priority = data.priority;
  if (data.tags !== undefined) patch.tags = data.tags;
  if (data.notes !== undefined) patch.notes = data.notes ?? null;
  if (data.sourceRef !== undefined) patch.sourceRef = data.sourceRef ?? null;

  const [updated] = await db.update(leads).set({ ...patch, updatedAt: new Date() }).where(eq(leads.id, id)).returning();

  await db.insert(leadActivities).values({
    leadId: id,
    type: 'NOTE',
    note: 'Lead details updated',
    performedById: actor.user.id,
    meta: { fields: Object.keys(patch) },
  });
  await writeAudit({ actor, action: 'UPDATE', entity: 'lead', entityId: id, oldValue: existing, newValue: updated });
  return updated ?? null;
}

export async function changeStatus(actor: Actor, id: string, rawData: unknown): Promise<Lead> {
  const canAccess = await canAccessLead(actor, id);
  if (!canAccess) throw new ApiError(404, 'Lead not found');
  const data = statusChangeSchema.parse(rawData);
  const existing = await db.query.leads.findFirst({ where: eq(leads.id, id) });
  if (!existing) throw new ApiError(404, 'Lead not found');

  const result = validateStatusChange(existing.status, data.status);
  const adminReopen = !result.ok && canReopen(actor.user.role) && data.status === 'NEW';
  if (!result.ok && !adminReopen) {
    throw new ApiError(422, result.reason ?? 'Invalid status transition');
  }

  const from = existing.status;
  const to = data.status;
  const [updated] = await db.update(leads).set({ status: to, updatedAt: new Date() }).where(eq(leads.id, id)).returning();

  await db.insert(leadStatusHistory).values({
    leadId: id,
    fromStatus: from,
    toStatus: to,
    reason: data.reason ?? null,
    changedById: actor.user.id,
  });
  await db.insert(leadActivities).values({
    leadId: id,
    type: 'STATUS_CHANGE',
    note: `Status moved ${from} → ${to}${data.reason ? ` — ${data.reason}` : ''}`,
    performedById: actor.user.id,
    meta: { from, to, reason: data.reason ?? null },
  });
  if (data.note) {
    await db.insert(leadActivities).values({
      leadId: id,
      type: 'NOTE',
      note: data.note,
      performedById: actor.user.id,
    });
  }
  await writeAudit({ actor, action: 'STATUS_CHANGE', entity: 'lead', entityId: id, oldValue: { status: from }, newValue: { status: to } });
  return updated as Lead;
}

export async function addLeadActivity(actor: Actor, id: string, rawData: unknown): Promise<void> {
  const canAccess = await canAccessLead(actor, id);
  if (!canAccess) throw new ApiError(404, 'Lead not found');
  const data = activityCreateSchema.parse(rawData);
  await db.insert(leadActivities).values({
    leadId: id,
    type: data.type,
    note: data.note ?? null,
    performedById: actor.user.id,
    meta: data.meta ?? {},
  });
}

export async function mergeLeads(actor: Actor, sourceId: string, targetId: string): Promise<Lead> {
  if (sourceId === targetId) throw new ApiError(422, 'Cannot merge a lead into itself');
  const source = await db.query.leads.findFirst({ where: eq(leads.id, sourceId) });
  const target = await db.query.leads.findFirst({ where: eq(leads.id, targetId) });
  if (!source || !target) throw new ApiError(404, 'Lead not found');

  await db.transaction(async (tx) => {
    await tx.update(leadActivities).set({ leadId: targetId }).where(eq(leadActivities.leadId, sourceId));
    await tx.update(leadStatusHistory).set({ leadId: targetId }).where(eq(leadStatusHistory.leadId, sourceId));
    await tx.update(leadAssignments).set({ leadId: targetId }).where(eq(leadAssignments.leadId, sourceId));
    await tx.update(followups).set({ leadId: targetId }).where(eq(followups.leadId, sourceId));
    await tx.update(meetings).set({ leadId: targetId }).where(eq(meetings.leadId, sourceId));

    const merged: Record<string, unknown> = { updatedAt: new Date() };
    for (const field of ['phone', 'whatsapp', 'email', 'campaign', 'adName', 'budget', 'preferredLocation', 'propertyType', 'requirement', 'notes'] as const) {
      const empty = target[field] === null || target[field] === '' || target[field] === undefined;
      if (empty && source[field] != null) merged[field] = source[field];
    }
    await tx.update(leads).set(merged).where(eq(leads.id, targetId));

    await tx
      .update(leads)
      .set({ status: 'DUPLICATE', isDuplicate: true, duplicateOfId: targetId, ownerId: null, assignedAt: null, updatedAt: new Date() })
      .where(eq(leads.id, sourceId));

    await tx
      .update(leadDuplicates)
      .set({ status: 'MERGED', resolvedAt: new Date(), resolvedById: actor.user.id })
      .where(eq(leadDuplicates.leadId, sourceId));
    await tx
      .update(leadDuplicates)
      .set({ status: 'MERGED', resolvedAt: new Date(), resolvedById: actor.user.id })
      .where(eq(leadDuplicates.leadId, targetId));

    await tx.insert(leadActivities).values({
      leadId: targetId,
      type: 'MERGE',
      note: `Merged duplicate lead ${source.leadNo} (${source.name}) into ${target.leadNo}`,
      performedById: actor.user.id,
      meta: { sourceId, sourceLeadNo: source.leadNo },
    });
  });

  await writeAudit({
    actor,
    action: 'MERGE',
    entity: 'lead',
    entityId: targetId,
    newValue: { mergedSource: sourceId },
    meta: { sourceLeadNo: source.leadNo, targetLeadNo: target.leadNo },
  });
  await notifyUser(actor.user.id, {
    type: 'SYSTEM',
    title: 'Leads merged',
    body: `${source.leadNo} merged into ${target.leadNo}`,
    entityType: 'lead',
    entityId: targetId,
  });
  return db.query.leads.findFirst({ where: eq(leads.id, targetId) }) as Promise<Lead>;
}

export async function resolveDuplicateV2(
  actor: Actor,
  leadId: string,
  duplicateOfId: string,
  resolution: 'IGNORE' | 'MERGE' | 'NOT_DUPLICATE',
): Promise<void> {
  await db
    .update(leadDuplicates)
    .set({
      status: resolution === 'MERGE' ? 'MERGED' : resolution === 'IGNORE' ? 'IGNORED' : 'NOT_DUPLICATE',
      resolvedAt: new Date(),
      resolvedById: actor.user.id,
    })
    .where(and(eq(leadDuplicates.leadId, leadId), eq(leadDuplicates.duplicateOfId, duplicateOfId)));
  if (resolution !== 'MERGE') {
    await db.update(leads).set({ isDuplicate: false, updatedAt: new Date() }).where(eq(leads.id, leadId));
  }
  await writeAudit({ actor, action: 'MERGE', entity: 'lead', entityId: leadId, newValue: { resolution, duplicateOfId } });
}

export async function deleteLead(actor: Actor, id: string): Promise<void> {
  const existing = await db.query.leads.findFirst({ where: eq(leads.id, id) });
  if (!existing) throw new ApiError(404, 'Lead not found');
  await db.delete(leads).where(eq(leads.id, id));
  await writeAudit({ actor, action: 'DELETE', entity: 'lead', entityId: id, newValue: { leadNo: existing.leadNo } });
}

export { ACTIVITY_TYPES, LEAD_SOURCES, type LeadStatus };