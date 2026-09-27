import { db } from '../db';
import { eq } from 'drizzle-orm';
import type { Actor } from '../api';
import type { Lead } from '../db/schema';
import { leadAssignments, leads, notifications, leadActivities } from '../db/schema';
import { listAssignableUsers, assertAssignableTarget } from './users';
import { getSetting } from '../settings';
import { assignmentConfigSchema } from '../validators';
import { writeAudit } from '../audit';

export type AssignmentMode = 'ROUND_ROBIN' | 'SOURCE_BASED' | 'PROJECT_BASED' | 'MANUAL';

export interface LeadAssignmentInput {
  lead: Lead;
  actor: Actor;
  forcedUserId?: string;
  rule?: string;
  skipIfAssigned?: boolean;
}

/**
 * Assign a lead following configured rules: ROUND_ROBIN (per-source),
 * SOURCE_BASED, PROJECT_BASED or MANUAL/forced assignments.
 */
export async function assignLead(input: LeadAssignmentInput): Promise<{ userId: string | null; rule: string }> {
  const { lead, actor, forcedUserId, rule } = input;

  if (lead.assignedAt && input.skipIfAssigned && lead.ownerId) {
    return { userId: lead.ownerId, rule: 'EXISTING' };
  }

  // Manual / forced assignment
  if (forcedUserId) {
    await assertAssignableTarget(actor.user, forcedUserId);
    await applyAssignment(lead.id, lead.ownerId, forcedUserId, rule ?? 'MANUAL', actor);
    return { userId: forcedUserId, rule: rule ?? 'MANUAL' };
  }

  const config = await getSetting('assignment.config', null);
  const parsed = config ? assignmentConfigSchema.safeParse(config) : null;
  const cfg = parsed?.success ? parsed.data : { mode: 'ROUND_ROBIN', sources: {}, projects: {} };
  const eligible = await listAssignableUsers();
  if (eligible.length === 0) {
    await writeAudit({ actor, action: 'ASSIGN', entity: 'lead', entityId: lead.id, meta: { note: 'No eligible assignees' } });
    return { userId: null, rule: 'NONE_ELIGIBLE' };
  }

  let pool = eligible;
  const cfgMode = (cfg.mode as AssignmentMode) ?? 'ROUND_ROBIN';
  let mode: AssignmentMode = cfgMode;
  const sourceMap = (cfg.sources ?? {}) as Record<string, string[]>;
  const projectMap = (cfg.projects ?? {}) as Record<string, string[]>;

  if (mode === 'SOURCE_BASED') {
    const ids = lead.source ? sourceMap[lead.source] ?? [] : [];
    pool = eligible.filter((u) => ids.includes(u.id));
  } else if (mode === 'PROJECT_BASED') {
    const ids = lead.projectId ? projectMap[lead.projectId] ?? [] : [];
    pool = eligible.filter((u) => ids.includes(u.id));
  }

  if (pool.length === 0) {
    // fall back to round-robin over the full eligible set
    pool = eligible;
    mode = 'ROUND_ROBIN';
  }

  const pick = await pickRoundRobin(mode, lead, pool);
  await applyAssignment(lead.id, lead.ownerId, pick, mode, actor);
  return { userId: pick, rule: mode };
}

async function pickRoundRobin(
  mode: AssignmentMode,
  lead: Lead,
  pool: Awaited<ReturnType<typeof listAssignableUsers>>,
): Promise<string> {
  if (mode === 'ROUND_ROBIN') {
    const { db } = await import('../db');
    const { sql } = await import('drizzle-orm');
    const key = `rr:${lead.source}`;
    const rows = await db.execute(
      sql`INSERT INTO counters (key, value) VALUES (${key}, 1)
          ON CONFLICT (key) DO UPDATE SET value = counters.value + 1
          RETURNING value`,
    );
    const res = rows as unknown as { rows?: Array<{ value: number }> };
    const seq = res.rows?.[0]?.value ?? 1;
    return pool[(seq - 1) % pool.length].id;
  }
  // first in the configured pool is picked for single-pool source/project modes
  return pool[0].id;
}

async function applyAssignment(
  leadId: string,
  fromUserId: string | null | undefined,
  toUserId: string,
  rule: string,
  actor: Actor,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(leadAssignments).values({
      leadId,
      fromUserId: fromUserId ?? null,
      toUserId,
      rule,
      assignedById: actor.user.id,
    });
    await tx
      .update(leads)
      .set({ ownerId: toUserId, assignedAt: new Date(), updatedAt: new Date() })
      .where(eq(leads.id, leadId));
    await tx.insert(leadActivities).values({
      leadId,
      type: 'ASSIGNMENT',
      note: `Lead assigned via ${rule}`,
      performedById: actor.user.id,
      meta: { from: fromUserId ?? null, to: toUserId },
    });
  });
  await db.insert(notifications).values({
    userId: toUserId,
    type: 'LEAD_ASSIGNED',
    title: 'New lead assigned to you',
    body: `A lead was assigned via ${rule}`,
    entityType: 'lead',
    entityId: leadId,
  });
  await writeAudit({
    actor,
    action: 'ASSIGN',
    entity: 'lead',
    entityId: leadId,
    newValue: { toUserId, rule },
    meta: { fromUserId: fromUserId ?? null },
  });
}