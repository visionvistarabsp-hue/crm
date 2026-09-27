import { db } from '../db';
import { desc, eq } from 'drizzle-orm';
import type { Actor } from '../api';
import { ApiError } from '../api';
import { automationRules, documents, customers, leads } from '../db/schema';
import { automationRuleSchema } from '../validators';
import { notifyUser, scheduleFollowupReminder, type NotifyArgs } from '../notifications';
import { writeAudit } from '../audit';
import { createFollowup } from './followups';

export type AutomationTrigger =
  | 'LEAD_CREATED'
  | 'LEAD_ASSIGNED'
  | 'LEAD_STATUS_CHANGED'
  | 'FOLLOWUP_COMPLETED'
  | 'FOLLOWUP_DONE'
  | 'MEETING_COMPLETED'
  | 'SITE_VISIT_COMPLETED'
  | 'VISIT_COMPLETED'
  | 'BOOKING_COMPLETED'
  | 'PAYMENT_RECEIVED';

interface AutomationContext {
  leadId?: string;
  customerId?: string;
  bookingId?: string;
  userId?: string; // performing/assigned user
  followupId?: string;
  meetingId?: string;
  status?: string;   // new lead status
  projectId?: string;
  [key: string]: unknown;
}

export async function listAutomationRules() {
  return db.query.automationRules.findMany({ orderBy: [desc(automationRules.createdAt)] });
}

export async function createAutomationRule(actor: Actor, rawData: unknown) {
  const data = automationRuleSchema.parse(rawData);
  const [rule] = await db.insert(automationRules).values({
    name: data.name,
    trigger: data.trigger,
    actions: data.actions as Array<Record<string, unknown>>,
    config: (data.config as Record<string, unknown>) ?? {},
    isActive: data.isActive,
    createdById: actor.user.id,
  }).returning();
  await writeAudit({ actor, action: 'CREATE', entity: 'automation-rule', entityId: rule.id, newValue: data });
  return rule;
}

export async function updateAutomationRule(actor: Actor, id: string, rawData: unknown) {
  const data = automationRuleSchema.partial().parse(rawData);
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (data.name !== undefined) update.name = data.name;
  if (data.trigger !== undefined) update.trigger = data.trigger;
  if (data.actions !== undefined) update.actions = data.actions;
  if (data.config !== undefined) update.config = data.config;
  if (data.isActive !== undefined) update.isActive = data.isActive;
  const [rule] = await db.update(automationRules).set(update).where(eq(automationRules.id, id)).returning();
  await writeAudit({ actor, action: 'UPDATE', entity: 'automation-rule', entityId: id, newValue: data });
  return rule;
}

export async function deleteAutomationRule(actor: Actor, id: string): Promise<void> {
  await db.delete(automationRules).where(eq(automationRules.id, id));
  await writeAudit({ actor, action: 'DELETE', entity: 'automation-rule', entityId: id });
}

async function applyAction(action: Record<string, unknown>, ctx: AutomationContext, actor: Actor): Promise<void> {
  const type = action.type as string;
  switch (type) {
    case 'CREATE_FOLLOWUP': {
      if (!ctx.customerId && !ctx.leadId) break;
      const days = typeof action.daysAfter === 'number' ? action.daysAfter : 1;
      const at = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
      const f = await createFollowup(actor, {
        leadId: ctx.leadId,
        customerId: ctx.customerId,
        type: (action.followupType as any) ?? 'CALL',
        scheduledAt: at,
        notes: ((action.note as string) ?? 'Automated follow-up'),
        assignedTo: (action.assignTo as string) ?? ctx.userId,
      });
      await scheduleFollowupReminder({
        followupId: f.id,
        userId: f.assignedTo ?? actor.user.id,
        scheduledAt: (f.reminderAt ?? at).toISOString(),
        leadName: undefined,
      });
      break;
    }
    case 'NOTIFY_USER': {
      if (!ctx.userId) break;
      const args: NotifyArgs = {
        type: 'SYSTEM',
        title: (action.title as string) ?? 'System notification',
        body: (action.body as string) ?? '',
      };
      if (action.entityType) args.entityType = action.entityType as string;
      if (action.entityId) args.entityId = action.entityId as string;
      await notifyUser(ctx.userId, args);
      break;
    }
    case 'CREATE_DOCUMENT_CHECKLIST': {
      if (!ctx.customerId) break;
      const defs = Array.isArray(action.documents) ? (action.documents as Array<{ type: string; title?: string }>) : [];
      const customer = await db.query.customers.findFirst({ where: eq(customers.id, ctx.customerId) });
      if (!customer) break;
      for (const d of defs) {
        await db.insert(documents).values({
          customerId: ctx.customerId,
          bookingId: ctx.bookingId ?? null,
          leadId: ctx.leadId ?? null,
          documentType: d.type,
          title: d.title ?? `Document ${d.type}`,
          fileName: '',
          r2Key: `pending/${customer.id}/${crypto.randomUUID()}`,
          mimeType: 'application/octet-stream',
          size: 0,
          verificationStatus: 'PENDING',
          uploadedById: actor.user.id,
          meta: { placeholder: true },
        });
      }
      break;
    }
    case 'UPDATE_STATUS': {
      if (!ctx.leadId) break;
      const target = action.status as string;
      if (target) {
        await db.update(leads).set({ status: target, updatedAt: new Date() }).where(eq(leads.id, ctx.leadId));
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Run all active rules for a trigger. Best-effort: never throws upstream.
 * Reads highlighting: executed in the background by the queue worker for
 * heavy triggers; lightweight calls run inline.
 */
export async function runAutomations(trigger: AutomationTrigger, ctx: AutomationContext, actor: Actor): Promise<void> {
  try {
    const rules = (await db.query.automationRules.findMany({})) ?? [];
    const matched = rules.filter((r) => r.isActive && r.trigger === trigger);
    for (const rule of matched) {
      for (const action of rule.actions ?? []) {
        if (!action) continue;
        await applyAction(action, ctx, actor);
      }
      await db.update(automationRules).set({ lastRunAt: new Date(), updatedAt: new Date() }).where(eq(automationRules.id, rule.id));
    }
  } catch (err) {
    console.error('[automation]', trigger, ctx, err);
  }
}