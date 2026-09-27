/**
 * Assistant tool definitions.
 *
 * Read tools run immediately inside the agent loop and their result is fed
 * back to the model. Write tools are NEVER executed here - they are only
 * *prepared*: validated, resolved against real rows, and turned into a
 * `PendingAction` the user must approve. The write itself happens in
 * `confirm.ts` after the user clicks Confirm.
 *
 * Splitting prepare from execute is what makes the confirm card trustworthy:
 * the card is built from validated database rows, never from model prose.
 */
import { ApiError, type Actor, validate } from '@/lib/api';
import {
  FOLLOWUP_TYPES,
  LEAD_STATUSES,
  MEETING_TYPES,
} from '@/lib/constants';
import {
  activityCreateSchema,
  assignLeadSchema,
  bookingCreateSchema,
  followupCreateSchema,
  meetingCreateSchema,
  statusChangeSchema,
} from '@/lib/validators';
import { addLeadActivity, changeStatus, getLead, listLeads, searchLeads, updateLead } from '../leads';
import { createFollowup, listFollowups, type FollowupView } from '../followups';
import { createMeeting, listMeetings } from '../meetings';
import { assertAssignableTarget } from '../users';
import { createBooking } from '../bookings';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolSpec {
  name: string;
  kind: 'read' | 'write';
  description: string;
  /** JSON Schema for the function arguments. */
  parameters: Record<string, unknown>;
}

export interface PendingAction {
  /** Client echoes this back to /api/assistant/confirm. */
  id: string;
  tool: string;
  /** One-line headline, e.g. "Schedule a CALL follow-up". */
  label: string;
  /** Concrete rows the user can check before approving. */
  detail: string[];
  /** Already-resolved identifiers, so confirm needs no further lookups. */
  target: { leadId?: string; leadName?: string };
  /** Validated payload handed straight to the service on confirm. */
  payload: Record<string, unknown>;
  /** Escalated caution (money, reassignment). */
  warning?: string;
}

export interface ReadToolResult {
  ok: boolean;
  [k: string]: unknown;
}

const LEAD_ID_DESC =
  'Exact lead id (uuid). You MUST obtain it from search_leads or get_lead first - never guess it.';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newActionId(): string {
  return globalThis.crypto.randomUUID();
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function fmtDate(v: string | Date | undefined | null): string {
  if (!v) return 'unspecified time';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function money(v: unknown): string {
  const n = asNumber(v);
  return n === undefined ? '0' : n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

/** Resolve a lead the model named, proving it exists and is visible to this user. */
interface ResolvedLead {
  id: string;
  name: string;
  leadNo: string | null;
  status: string;
  ownerName: string | null;
}

/**
 * Turn a model-supplied lead id into a lead the actor can actually see.
 * `getLead` is the visibility gate, so anything it returns is safe to show.
 */
async function resolveLead(actor: Actor, leadId: string, what: string): Promise<ResolvedLead> {
  const lead = await getLead(actor, leadId);
  if (!lead) {
    throw new ApiError(
      404,
      `Lead not found or not accessible to you, so ${what} cannot be prepared. Use search_leads to find the right lead.`,
      'LEAD_NOT_FOUND',
    );
  }
  return {
    id: lead.id,
    name: lead.name,
    leadNo: lead.leadNo,
    status: lead.status,
    ownerName: lead.ownerName,
  };
}

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

export const READ_TOOLS: ToolSpec[] = [
  {
    name: 'list_followups',
    kind: 'read',
    description:
      'List follow-up tasks. view=today|upcoming|overdue|done|all. Use this for "what is due", "aaj kya karna hai", "pending calls".',
    parameters: {
      type: 'object',
      properties: {
        view: {
          type: 'string',
          enum: ['today', 'upcoming', 'overdue', 'done', 'all'],
          description: 'Which bucket to read. Defaults to today.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 25, description: 'Max rows, default 10.' },
      },
      required: [],
    },
  },
  {
    name: 'list_meetings',
    kind: 'read',
    description:
      'List meetings and site visits, optionally within a date range. Use this for "site visits today", "meetings this week".',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['MEETING', 'SITE_VISIT', 'ALL'], description: 'Defaults to ALL.' },
        from: { type: 'string', description: 'ISO date, inclusive lower bound.' },
        to: { type: 'string', description: 'ISO date, inclusive upper bound.' },
        limit: { type: 'integer', minimum: 1, maximum: 25, description: 'Max rows, default 10.' },
      },
      required: [],
    },
  },
  {
    name: 'search_leads',
    kind: 'read',
    description:
      'Search leads by name, phone or lead number. Use this whenever the user names a person instead of an id, and to disambiguate.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name, phone or lead number fragment.' },
        status: { type: 'string', description: 'Optional pipeline status filter.' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Max rows, default 6.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_lead',
    kind: 'read',
    description:
      'Fetch one lead with its recent timeline activities, follow-ups and status history. Use before writing anything so the details are right.',
    parameters: {
      type: 'object',
      properties: { leadId: { type: 'string', description: LEAD_ID_DESC } },
      required: ['leadId'],
    },
  },
];

export async function runReadTool(
  actor: Actor,
  name: string,
  args: Record<string, unknown>,
): Promise<ReadToolResult> {
  try {
    switch (name) {
      case 'list_followups': {
        const view = (asString(args.view) ?? 'today') as FollowupView;
        const allowed: FollowupView[] = ['today', 'upcoming', 'overdue', 'done', 'all'];
        if (!allowed.includes(view)) throw new ApiError(400, `view must be one of ${allowed.join(', ')}`);
        const pageSize = Math.min(25, Math.max(1, asNumber(args.limit) ?? 10));
        const { items, total } = await listFollowups(actor, { view, page: 1, pageSize });
        return {
          ok: true,
          view,
          total,
          items: items.map((f) => ({
            id: f.id,
            type: f.type,
            status: f.status,
            scheduledAt: f.scheduledAt,
            notes: f.notes,
            leadId: f.leadId,
            leadName: f.leadName,
            leadNo: f.leadNo,
            assignee: f.assigneeName ?? null,
          })),
        };
      }

      case 'list_meetings': {
        const type = (asString(args.type) ?? 'ALL') as 'MEETING' | 'SITE_VISIT' | 'ALL';
        if (!['MEETING', 'SITE_VISIT', 'ALL'].includes(type)) {
          throw new ApiError(400, 'type must be MEETING, SITE_VISIT or ALL');
        }
        const pageSize = Math.min(25, Math.max(1, asNumber(args.limit) ?? 10));
        const { items, total } = await listMeetings(actor, {
          type,
          from: asString(args.from),
          to: asString(args.to),
          page: 1,
          pageSize,
        });
        return {
          ok: true,
          total,
          items: items.map((m) => ({
            id: m.id,
            type: m.type,
            status: m.status,
            title: m.title,
            scheduledAt: m.scheduledAt,
            location: m.location,
            leadId: m.leadId,
            leadName: m.leadName,
            project: m.projectName,
            assignee: m.assigneeName,
          })),
        };
      }

      case 'search_leads': {
        const q = asString(args.query);
        if (!q) throw new ApiError(400, 'query is required');
        const limit = Math.min(20, Math.max(1, asNumber(args.limit) ?? 6));
        const status = asString(args.status);
        // Narrow exact-id/phone lookups through searchLeads, fall back to list search.
        const found = await searchLeads(actor, q, limit);
        const rows = found.length
          ? found
          : (await listLeads(actor, { search: q, status, page: 1, pageSize: limit })).items;
        return {
          ok: true,
          total: rows.length,
          items: rows.map((l) => ({
            id: l.id,
            leadNo: l.leadNo,
            name: l.name,
            phone: l.phone,
            status: l.status,
            priority: l.priority,
            budget: l.budget,
            owner: l.ownerName,
            project: l.projectName,
          })),
        };
      }

      case 'get_lead': {
        const leadId = asString(args.leadId);
        if (!leadId) throw new ApiError(400, 'leadId is required');
        const lead = await getLead(actor, leadId);
        if (!lead) throw new ApiError(404, 'Lead not found or not accessible to you');
        const acts = (lead.activities ?? []) as Array<Record<string, unknown>>;
        return {
          ok: true,
          lead: {
            id: lead.id,
            leadNo: lead.leadNo,
            name: lead.name,
            phone: lead.phone,
            whatsapp: lead.whatsapp,
            status: lead.status,
            priority: lead.priority,
            source: lead.source,
            campaign: lead.campaign,
            budget: lead.budget,
            requirement: lead.requirement,
            preferredLocation: lead.preferredLocation,
            propertyType: lead.propertyType,
            notes: lead.notes,
            owner: lead.ownerName,
            project: lead.projectName,
            nextFollowupAt: lead.nextFollowupAt,
            createdAt: lead.createdAt,
          },
          recentActivities: acts.slice(0, 8).map((a) => ({
            type: a.type,
            note: a.note,
            createdAt: a.createdAt,
          })),
          upcomingFollowups: ((lead.followupsList ?? []) as Array<Record<string, unknown>>)
            .filter((f) => f.status === 'PENDING')
            .slice(0, 5)
            .map((f) => ({ type: f.type, scheduledAt: f.scheduledAt, notes: f.notes })),
        };
      }

      default:
        throw new ApiError(400, `Unknown tool ${name}`);
    }
  } catch (err) {
    // Tool errors are reported back to the model so it can recover, not thrown.
    return {
      ok: false,
      error: err instanceof ApiError ? err.message : 'Tool failed unexpectedly',
    };
  }
}

// ---------------------------------------------------------------------------
// Write tools - prepare only, never execute
// ---------------------------------------------------------------------------

export const WRITE_TOOLS: ToolSpec[] = [
  {
    name: 'create_followup',
    kind: 'write',
    description:
      'Schedule a follow-up task on a lead. Ask for confirmation before calling; the system shows the user a card.',
    parameters: {
      type: 'object',
      properties: {
        leadId: { type: 'string', description: LEAD_ID_DESC },
        type: { type: 'string', enum: [...FOLLOWUP_TYPES], description: 'Defaults to CALL.' },
        scheduledAt: { type: 'string', description: 'ISO 8601 datetime.' },
        notes: { type: 'string', description: 'What to cover on the call.' },
        assignedTo: { type: 'string', description: 'Optional user id of the assignee.' },
      },
      required: ['leadId', 'scheduledAt'],
    },
  },
  {
    name: 'add_lead_note',
    kind: 'write',
    description: 'Append a note to a lead timeline. Never overwrites existing notes.',
    parameters: {
      type: 'object',
      properties: {
        leadId: { type: 'string', description: LEAD_ID_DESC },
        note: { type: 'string', description: 'The note text as the user said it.' },
        type: { type: 'string', description: 'Optional activity type; defaults to NOTE.' },
      },
      required: ['leadId', 'note'],
    },
  },
  {
    name: 'create_meeting',
    kind: 'write',
    description: 'Book a meeting or site visit against a lead.',
    parameters: {
      type: 'object',
      properties: {
        leadId: { type: 'string', description: LEAD_ID_DESC },
        type: { type: 'string', enum: [...MEETING_TYPES], description: 'MEETING or SITE_VISIT.' },
        scheduledAt: { type: 'string', description: 'ISO 8601 datetime.' },
        title: { type: 'string' },
        location: { type: 'string', description: 'Site address or meeting link.' },
        projectId: { type: 'string', description: 'Optional project id.' },
        visitNumber: { type: 'integer', minimum: 1, maximum: 3 },
        notes: { type: 'string' },
      },
      required: ['leadId', 'scheduledAt'],
    },
  },
  {
    name: 'change_lead_status',
    kind: 'write',
    description: 'Move a lead to a different pipeline status.',
    parameters: {
      type: 'object',
      properties: {
        leadId: { type: 'string', description: LEAD_ID_DESC },
        status: { type: 'string', enum: [...LEAD_STATUSES] },
        reason: { type: 'string', description: 'Why the status is changing.' },
      },
      required: ['leadId', 'status'],
    },
  },
  {
    name: 'reassign_lead',
    kind: 'write',
    description:
      'Reassign a lead to another team member. The target must already exist in the team directory.',
    parameters: {
      type: 'object',
      properties: {
        leadId: { type: 'string', description: LEAD_ID_DESC },
        userId: { type: 'string', description: 'Id of the new owner. Look this up, never invent it.' },
        rule: { type: 'string', description: 'Optional routing rule label.' },
      },
      required: ['leadId', 'userId'],
    },
  },
  {
    name: 'create_booking',
    kind: 'write',
    description:
      'Create a booking. This commits a sale amount, so the confirm card shows the money explicitly. Only use it when the user has given the amount and unit.',
    parameters: {
      type: 'object',
      properties: {
        leadId: { type: 'string', description: LEAD_ID_DESC },
        projectId: { type: 'string', description: 'Required project id.' },
        unitId: { type: 'string', description: 'Optional unit id.' },
        saleValue: { type: 'number', description: 'Total sale value in rupees. Must be > 0.' },
        bookingAmount: { type: 'number', description: 'Booking/token amount in rupees.' },
        bookingDate: { type: 'string', description: 'ISO 8601 date. Must be today or later.' },
        notes: { type: 'string' },
      },
      required: ['leadId', 'projectId', 'saleValue', 'bookingDate'],
    },
  },
];

export const ALL_TOOLS: ToolSpec[] = [...READ_TOOLS, ...WRITE_TOOLS];

/** Groq wire format for the tools array. */
export function groqTools(): Array<Record<string, unknown>> {
  return ALL_TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export function toolKind(name: string): 'read' | 'write' | null {
  return ALL_TOOLS.find((t) => t.name === name)?.kind ?? null;
}

/**
 * Validate a proposed write and turn it into a confirm card. Performs no
 * database writes - only reads used to prove the target exists and is
 * visible, plus permission/ownership assertions.
 */
export async function prepareWriteTool(
  actor: Actor,
  name: string,
  args: Record<string, unknown>,
): Promise<PendingAction> {
  const id = newActionId();

  switch (name) {
    case 'create_followup': {
      const leadId = asString(args.leadId);
      if (!leadId) throw new ApiError(400, 'leadId is required');
      // Validate the model's payload before spending a database round trip.
      const payload = validate(followupCreateSchema, {
        leadId,
        type: asString(args.type) ?? 'CALL',
        scheduledAt: asString(args.scheduledAt) ?? '',
        notes: asString(args.notes),
        assignedTo: asString(args.assignedTo),
      }) as Record<string, unknown>;
      const lead = await resolveLead(actor, leadId, 'a follow-up');
      const type = String(payload.type);
      return {
        id,
        tool: name,
        label: `Schedule a ${type.replace('_', ' ').toLowerCase()} follow-up`,
        detail: [
          `Lead: ${lead.name}`,
          `When: ${fmtDate(payload.scheduledAt as string)}`,
          ...(payload.notes ? [`Notes: ${String(payload.notes)}`] : []),
        ],
        target: { leadId: lead.id, leadName: lead.name },
        payload: payload as Record<string, unknown>,
      };
    }

    case 'add_lead_note': {
      const leadId = asString(args.leadId);
      if (!leadId) throw new ApiError(400, 'leadId is required');
      const note = asString(args.note);
      if (!note) throw new ApiError(400, 'note is required and cannot be empty');
      const lead = await resolveLead(actor, leadId, 'a note');
      const payload = validate(activityCreateSchema, {
        type: asString(args.type) ?? 'NOTE',
        note,
      }) as Record<string, unknown>;
      return {
        id,
        tool: name,
        label: 'Add a note to the lead timeline',
        detail: [`Lead: ${lead.name}`, `Note: ${String(payload.note)}`],
        target: { leadId: lead.id, leadName: lead.name },
        payload: { leadId: lead.id, ...payload },
      };
    }

    case 'create_meeting': {
      const leadId = asString(args.leadId);
      if (!leadId) throw new ApiError(400, 'leadId is required');
      const payload = validate(meetingCreateSchema, {
        leadId,
        type: asString(args.type) ?? 'MEETING',
        scheduledAt: asString(args.scheduledAt) ?? '',
        title: asString(args.title),
        location: asString(args.location),
        projectId: asString(args.projectId),
        visitNumber: asNumber(args.visitNumber),
        notes: asString(args.notes),
      }) as Record<string, unknown>;
      const lead = await resolveLead(actor, leadId, 'a meeting');
      const kind = String(payload.type) === 'SITE_VISIT' ? 'Site visit' : 'Meeting';
      return {
        id,
        tool: name,
        label: `Book a ${kind.toLowerCase()}`,
        detail: [
          `Lead: ${lead.name}`,
          `When: ${fmtDate(payload.scheduledAt as string)}`,
          ...(payload.location ? [`Location: ${String(payload.location)}`] : []),
          ...(payload.title ? [`Title: ${String(payload.title)}`] : []),
        ],
        target: { leadId: lead.id, leadName: lead.name },
        payload: payload as Record<string, unknown>,
      };
    }

    case 'change_lead_status': {
      const leadId = asString(args.leadId);
      if (!leadId) throw new ApiError(400, 'leadId is required');
      const payload = validate(statusChangeSchema, {
        status: asString(args.status) ?? '',
        reason: asString(args.reason),
      }) as Record<string, unknown>;
      const lead = await resolveLead(actor, leadId, 'a status change');
      return {
        id,
        tool: name,
        label: 'Change lead status',
        detail: [
          `Lead: ${lead.name}`,
          `From: ${lead.status}`,
          `To: ${String(payload.status)}`,
          ...(payload.reason ? [`Reason: ${String(payload.reason)}`] : []),
        ],
        target: { leadId: lead.id, leadName: lead.name },
        payload: { leadId: lead.id, ...payload },
      };
    }

    case 'reassign_lead': {
      const leadId = asString(args.leadId);
      if (!leadId) throw new ApiError(400, 'leadId is required');
      const userId = asString(args.userId);
      if (!userId) throw new ApiError(400, 'userId is required');
      const lead = await resolveLead(actor, leadId, 'a reassignment');
      // Enforces the reporting line and the actor's right to assign.
      await assertAssignableTarget(actor.user, userId);
      const payload = validate(assignLeadSchema, { userId }) as Record<string, unknown>;
      return {
        id,
        tool: name,
        label: 'Reassign lead owner',
        detail: [
          `Lead: ${lead.name} (${lead.leadNo ?? lead.id})`,
          `Current owner: ${lead.ownerName ?? 'unassigned'}`,
          `New owner: user ${String(payload.userId)}`,
        ],
        target: { leadId: lead.id, leadName: lead.name },
        payload: { leadId: lead.id, ...payload },
        warning: 'Ownership will change hands immediately.',
      };
    }

    case 'create_booking': {
      const leadId = asString(args.leadId);
      if (!leadId) throw new ApiError(400, 'leadId is required');
      const projectId = asString(args.projectId);
      if (!projectId) throw new ApiError(400, 'projectId is required');
      const saleValue = asNumber(args.saleValue);
      if (!saleValue || saleValue <= 0) {
        throw new ApiError(400, 'saleValue must be a number greater than 0');
      }
      const bookingDate = asString(args.bookingDate);
      if (!bookingDate || Number.isNaN(Date.parse(bookingDate))) {
        throw new ApiError(400, 'bookingDate must be a valid date');
      }
      if (new Date(bookingDate).getTime() < Date.now() - 86_400_000) {
        throw new ApiError(400, 'bookingDate cannot be in the past');
      }
      const payload = validate(bookingCreateSchema, {
        leadId,
        projectId,
        unitId: asString(args.unitId),
        saleValue,
        bookingAmount: asNumber(args.bookingAmount) ?? 0,
        bookingDate,
        notes: asString(args.notes),
      }) as Record<string, unknown>;
      const lead = await resolveLead(actor, leadId, 'a booking');
      const bookingAmount = asNumber(payload.bookingAmount) ?? 0;
      return {
        id,
        tool: name,
        label: 'Create a booking',
        detail: [
          `Lead: ${lead.name}`,
          `Project id: ${String(payload.projectId)}`,
          ...(payload.unitId ? [`Unit id: ${String(payload.unitId)}`] : []),
          `Sale value: Rs ${money(payload.saleValue)}`,
          `Booking amount: Rs ${money(bookingAmount)}`,
          `Booking date: ${fmtDate(payload.bookingDate as string)}`,
        ],
        target: { leadId: lead.id, leadName: lead.name },
        payload: payload as Record<string, unknown>,
        warning: 'This commits a sale amount and converts the lead. Check the figure before confirming.',
      };
    }

    default:
      throw new ApiError(400, `Unknown write tool ${name}`);
  }
}

/** Map a Groq tool_call object to a tool name + parsed arguments. */
export function readToolCall(tc: { function?: { name?: string; arguments?: string } }) {
  const name = tc.function?.name ?? '';
  return { name, args: parseArgs(tc.function?.arguments ?? '{}') };
}

// ---------------------------------------------------------------------------
// Execution (only reachable from confirm.ts, i.e. only after the user agreed)
// ---------------------------------------------------------------------------

export async function executeWriteTool(
  actor: Actor,
  action: PendingAction,
): Promise<{ summary: string; entityId: string }> {
  const { tool, payload } = action;
  switch (tool) {
    case 'create_followup': {
      const row = await createFollowup(actor, payload);
      return { summary: `Follow-up scheduled for ${fmtDate(row.scheduledAt)}`, entityId: row.id };
    }
    case 'add_lead_note': {
      const { leadId, ...rest } = payload;
      await addLeadActivity(actor, String(leadId), rest);
      return { summary: 'Note added to timeline', entityId: String(leadId) };
    }
    case 'create_meeting': {
      const row = await createMeeting(actor, payload);
      return {
        summary: `${row.type === 'SITE_VISIT' ? 'Site visit' : 'Meeting'} booked for ${fmtDate(row.scheduledAt)}`,
        entityId: row.id,
      };
    }
    case 'change_lead_status': {
      const { leadId, ...rest } = payload;
      const row = await changeStatus(actor, String(leadId), rest);
      return { summary: `Status is now ${row.status}`, entityId: row.id };
    }
    case 'reassign_lead': {
      const { leadId, ...rest } = payload;
      const row = await updateLead(actor, String(leadId), { ownerId: rest.userId });
      if (!row) throw new ApiError(404, 'Lead disappeared before the reassignment could be applied');
      return { summary: 'Lead reassigned', entityId: row.id };
    }
    case 'create_booking': {
      const row = await createBooking(actor, payload);
      return { summary: `Booking created for Rs ${money(row.saleValue)}`, entityId: row.id };
    }
    default:
      throw new ApiError(400, `Unknown write tool ${tool}`);
  }
}
