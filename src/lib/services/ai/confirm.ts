/**
 * Applying confirmed assistant writes.
 *
 * This module is the only path from a proposed action to a real database
 * write. It re-checks visibility and permissions at apply time (a queued card
 * may sit in the UI for minutes), then delegates to the normal service layer
 * and records an audit row naming the assistant as the author.
 *
 * Nothing here is reachable without an explicit user action: the API route
 * requires the client to echo back the action ids it was shown.
 */
import { ApiError, type Actor } from '@/lib/api';
import { writeAudit } from '@/lib/audit';
import { getLead } from '../leads';
import { assertAssignableTarget } from '../users';
import { executeWriteTool, type PendingAction } from './tools';

export interface ConfirmOutcome {
  id: string;
  tool: string;
  label: string;
  ok: boolean;
  summary?: string;
  error?: string;
  entityId?: string;
}

/** Which entity each write lands on, for the audit trail. */
const AUDIT_ENTITY: Record<string, string> = {
  create_followup: 'followup',
  add_lead_note: 'lead',
  create_meeting: 'meeting',
  change_lead_status: 'lead',
  reassign_lead: 'lead',
  create_booking: 'booking',
};

/**
 * Re-prove the action is still legal for this actor. Throws ApiError when not.
 * Pure reads - no writes.
 *
 * Split in two so the argument rules stay testable without a database:
 * `validateActionShape` is pure, `revalidate` adds the visibility lookups.
 */
export function validateActionShape(action: PendingAction): void {
  switch (action.tool) {
    case 'reassign_lead': {
      const userId = action.payload.userId;
      if (typeof userId !== 'string' || !userId) {
        throw new ApiError(400, 'Reassignment is missing its target user');
      }
      break;
    }
    case 'create_booking': {
      const sale = Number(action.payload.saleValue);
      if (!Number.isFinite(sale) || sale <= 0) {
        throw new ApiError(400, 'Booking sale value must be greater than 0');
      }
      const d = new Date(String(action.payload.bookingDate));
      if (Number.isNaN(d.getTime()) || d.getTime() < Date.now() - 86_400_000) {
        throw new ApiError(400, 'Booking date must be today or later');
      }
      break;
    }
    case 'change_lead_status': {
      if (!action.payload.status) throw new ApiError(400, 'Status change is missing its target status');
      break;
    }
    case 'create_followup':
    case 'create_meeting':
    case 'add_lead_note': {
      if (!action.payload.leadId && !action.target.leadId) {
        throw new ApiError(400, 'This action is not linked to a lead');
      }
      break;
    }
    default:
      break;
  }
}

async function revalidate(actor: Actor, action: PendingAction): Promise<void> {
  validateActionShape(action);

  const leadId = action.target.leadId ?? (action.payload.leadId as string | undefined);
  if (leadId) {
    // Throws 404 when the lead no longer exists or is outside the actor's scope.
    await getLead(actor, leadId);
  }

  if (action.tool === 'reassign_lead') {
    // Re-checks the reporting line: a queued card may outlive a role change.
    await assertAssignableTarget(actor.user, action.payload.userId as string);
  }
}

/**
 * Apply the selected subset of proposed actions. Each action is independent:
 * one failure does not roll back the others, and every outcome is reported.
 */
export async function applyConfirmedActions(
  actor: Actor,
  actions: PendingAction[],
  selectedIds: string[],
): Promise<ConfirmOutcome[]> {
  const wanted = new Set(selectedIds);
  const chosen = actions.filter((a) => wanted.has(a.id));
  if (chosen.length === 0) {
    throw new ApiError(400, 'None of the proposed actions matched. Refresh the conversation.');
  }

  const outcomes: ConfirmOutcome[] = [];
  for (const action of chosen) {
    try {
      await revalidate(actor, action);
      const result = await executeWriteTool(actor, action);
      await writeAudit({
        actor,
        action: 'AI_ASSISTANT_APPLY',
        entity: AUDIT_ENTITY[action.tool] ?? 'assistant',
        entityId: result.entityId,
        newValue: { tool: action.tool, payload: action.payload },
        meta: { source: 'assistant', target: action.target },
      });
      outcomes.push({ id: action.id, tool: action.tool, label: action.label, ok: true, ...result });
    } catch (err) {
      outcomes.push({
        id: action.id,
        tool: action.tool,
        label: action.label,
        ok: false,
        error: err instanceof ApiError ? err.message : 'Could not apply this change',
      });
      await writeAudit({
        actor,
        action: 'AI_ASSISTANT_APPLY',
        entity: AUDIT_ENTITY[action.tool] ?? 'assistant',
        entityId: action.target.leadId ?? null,
        meta: { source: 'assistant', outcome: 'failed', error: String(err) },
      });
    }
  }
  return outcomes;
}
