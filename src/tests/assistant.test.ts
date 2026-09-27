/**
 * Assistant tool contract and validation tests.
 *
 * Everything here is offline: the database and the service layer are mocked so
 * the suite never opens a socket. That is deliberate - the point is to pin the
 * guarantees the agent loop relies on (reads run, writes only queue) and the
 * argument rules that stop a bad model call from becoming a bad write.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The db module builds a Pool at import time. Stub it so importing the
// services below cannot open a connection.
vi.mock('@/lib/db', () => ({ db: {}, pool: {} }));

vi.mock('@/lib/services/leads', () => ({
  addLeadActivity: vi.fn(async () => undefined),
  changeStatus: vi.fn(async () => ({ id: 'L1', status: 'NEGOTIATION' })),
  getLead: vi.fn(async () => ({
    id: 'L1',
    leadNo: 'LD-0001',
    name: 'Asha Verma',
    phone: '9999999999',
    whatsapp: null,
    status: 'NEW',
    priority: 'MEDIUM',
    source: 'Website',
    campaign: null,
    budget: '7500000',
    requirement: '2 BHK',
    preferredLocation: 'Pune',
    propertyType: 'APARTMENT',
    notes: null,
    ownerName: 'Ravi Kumar',
    projectName: 'Green Park',
    nextFollowupAt: null,
    createdAt: new Date('2026-01-01'),
    activities: [],
    followupsList: [],
  })),
  listLeads: vi.fn(async () => ({ items: [], total: 0 })),
  searchLeads: vi.fn(async () => []),
  updateLead: vi.fn(async () => ({ id: 'L1' })),
}));

vi.mock('@/lib/services/followups', () => ({
  createFollowup: vi.fn(async () => ({ id: 'F1', scheduledAt: '2026-10-01T10:00:00.000Z' })),
  listFollowups: vi.fn(async () => ({
    items: [
      {
        id: 'F1',
        type: 'CALL',
        status: 'PENDING',
        scheduledAt: '2026-10-01T10:00:00.000Z',
        notes: 'discuss payment plan',
        leadId: 'L1',
        leadName: 'Asha Verma',
        leadNo: 'LD-0001',
        assigneeName: 'Ravi Kumar',
      },
    ],
    total: 1,
  })),
}));

vi.mock('@/lib/services/meetings', () => ({
  createMeeting: vi.fn(async () => ({ id: 'M1', type: 'SITE_VISIT', scheduledAt: '2026-10-01T10:00:00.000Z' })),
  listMeetings: vi.fn(async () => ({ items: [], total: 0 })),
}));

vi.mock('@/lib/services/bookings', () => ({
  createBooking: vi.fn(async () => ({ id: 'B1', saleValue: '8500000' })),
}));

vi.mock('@/lib/services/users', () => ({
  assertAssignableTarget: vi.fn(async () => ({ id: 'U2', name: 'Neha', isActive: true })),
}));

vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn(async () => undefined) }));

import { FOLLOWUP_TYPES, LEAD_STATUSES, MEETING_TYPES } from '@/lib/constants';
import {
  ALL_TOOLS,
  READ_TOOLS,
  WRITE_TOOLS,
  groqTools,
  prepareWriteTool,
  readToolCall,
  runReadTool,
  toolKind,
  type PendingAction,
} from '@/lib/services/ai/tools';
import { validateActionShape } from '@/lib/services/ai/confirm';
import { trimHistory, dedupePending, retryDelayMs } from '@/lib/services/ai/agent';
import { createFollowup } from '@/lib/services/followups';
import { createBooking } from '@/lib/services/bookings';

const actor = {
  user: {
    id: 'U1',
    name: 'Ravi Kumar',
    email: 'ravi@example.com',
    role: 'SALES_MANAGER',
    permissions: [],
    isSuperAdmin: false,
  },
  ip: null,
  userAgent: null,
  path: '/api/assistant',
  method: 'POST',
} as never;

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tool catalogue
// ---------------------------------------------------------------------------

describe('tool catalogue', () => {
  it('exposes exactly ten tools', () => {
    expect(ALL_TOOLS).toHaveLength(10);
  });

  it('splits them into four reads and six writes', () => {
    expect(READ_TOOLS).toHaveLength(4);
    expect(WRITE_TOOLS).toHaveLength(6);
  });

  it('has no duplicate tool names', () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every tool a description and an object parameter schema', () => {
    for (const t of ALL_TOOLS) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.parameters.type).toBe('object');
      expect(t.parameters.properties).toBeTypeOf('object');
    }
  });

  it('only requires parameters that are actually declared', () => {
    for (const t of ALL_TOOLS) {
      const required = (t.parameters.required as string[] | undefined) ?? [];
      const props = t.parameters.properties as Record<string, unknown>;
      for (const key of required) {
        expect(Object.keys(props)).toContain(key);
      }
    }
  });

  it('keeps every write tool gated behind a lead id', () => {
    for (const t of WRITE_TOOLS) {
      const required = (t.parameters.required as string[] | undefined) ?? [];
      expect(required).toContain('leadId');
    }
  });

  it('draws enum values from the shared constants, not hand-copied lists', () => {
    const enumOf = (name: string, prop: string) => {
      const t = ALL_TOOLS.find((x) => x.name === name)!;
      const props = t.parameters.properties as Record<string, { enum?: string[] }>;
      return props[prop]?.enum;
    };
    expect(enumOf('create_followup', 'type')).toEqual([...FOLLOWUP_TYPES]);
    expect(enumOf('create_meeting', 'type')).toEqual([...MEETING_TYPES]);
    expect(enumOf('change_lead_status', 'status')).toEqual([...LEAD_STATUSES]);
  });
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe('tool classification', () => {
  it('routes reads and writes to the right handler', () => {
    expect(toolKind('get_lead')).toBe('read');
    expect(toolKind('search_leads')).toBe('read');
    expect(toolKind('create_followup')).toBe('write');
    expect(toolKind('create_booking')).toBe('write');
  });

  it('returns null for an unknown name rather than defaulting to a kind', () => {
    expect(toolKind('drop_database')).toBeNull();
  });

  it('parses a well-formed tool call', () => {
    const { name, args } = readToolCall({
      function: { name: 'get_lead', arguments: '{"leadId":"L1"}' },
    });
    expect(name).toBe('get_lead');
    expect(args).toEqual({ leadId: 'L1' });
  });

  it('survives the empty and malformed argument strings a model sometimes emits', () => {
    expect(readToolCall({ function: { name: 'get_lead', arguments: '' } }).args).toEqual({});
    expect(readToolCall({ function: { name: 'get_lead' } }).args).toEqual({});
    expect(readToolCall({ function: { name: 'get_lead', arguments: '{oops' } }).args).toEqual({});
  });

  it('emits the Groq wire format', () => {
    const wire = groqTools();
    expect(wire).toHaveLength(10);
    for (const entry of wire) {
      expect(entry.type).toBe('function');
      const fn = entry.function as Record<string, unknown>;
      expect(typeof fn.name).toBe('string');
      expect(typeof fn.description).toBe('string');
      expect(fn.parameters).toBeTypeOf('object');
    }
  });
});

// ---------------------------------------------------------------------------
// Read tools run inline
// ---------------------------------------------------------------------------

describe('read tools', () => {
  it('returns rows rather than queuing anything', async () => {
    const res = await runReadTool(actor, 'list_followups', { view: 'today' });
    expect(res.ok).toBe(true);
    expect(Array.isArray(res.items)).toBe(true);
  });

  it('rejects an out-of-range view instead of silently defaulting', async () => {
    const res = await runReadTool(actor, 'list_followups', { view: 'last_tuesday' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/view must be one of/);
  });

  it('clamps a nonsense limit to a sane page size', async () => {
    const res = await runReadTool(actor, 'list_followups', { view: 'today', limit: 99999 });
    expect(res.ok).toBe(true);
  });

  it('reports a tool failure back to the model instead of throwing', async () => {
    const res = await runReadTool(actor, 'search_leads', {});
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/query is required/);
  });

  it('rejects an unknown tool name', async () => {
    const res = await runReadTool(actor, 'defeat_the_enemy', {});
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Write tools only ever prepare
// ---------------------------------------------------------------------------

describe('write tools never write during prepare', () => {
  it('creates no database row for a follow-up', async () => {
    const action = await prepareWriteTool(actor, 'create_followup', {
      leadId: 'L1',
      scheduledAt: '2026-10-01T10:00:00.000Z',
    });
    expect(action.tool).toBe('create_followup');
    expect(createFollowup).not.toHaveBeenCalled();
  });

  it('creates no database row for a booking', async () => {
    const action = await prepareWriteTool(actor, 'create_booking', {
      leadId: 'L1',
      projectId: 'P1',
      saleValue: 8_500_000,
      bookingAmount: 500_000,
      bookingDate: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(action.warning).toMatch(/commits a sale amount/i);
    expect(createBooking).not.toHaveBeenCalled();
  });

  it('resolves the lead to a real name so the card is not model prose', async () => {
    const action = await prepareWriteTool(actor, 'add_lead_note', {
      leadId: 'L1',
      note: 'Wants a bigger flat',
    });
    expect(action.target).toEqual({ leadId: 'L1', leadName: 'Asha Verma' });
    expect(action.detail.join(' ')).toContain('Asha Verma');
  });

  it('rejects a note the model left blank', async () => {
    await expect(
      prepareWriteTool(actor, 'add_lead_note', { leadId: 'L1', note: '   ' }),
    ).rejects.toThrow(/note is required/i);
  });

  it('rejects a follow-up with no time', async () => {
    await expect(
      prepareWriteTool(actor, 'create_followup', { leadId: 'L1' }),
    ).rejects.toThrow();
  });

  it('refuses a booking with a non-positive sale value', async () => {
    await expect(
      prepareWriteTool(actor, 'create_booking', {
        leadId: 'L1',
        projectId: 'P1',
        saleValue: 0,
        bookingDate: '2099-01-01',
      }),
    ).rejects.toThrow(/greater than 0/i);
  });

  it('refuses a booking dated in the past', async () => {
    await expect(
      prepareWriteTool(actor, 'create_booking', {
        leadId: 'L1',
        projectId: 'P1',
        saleValue: 100,
        bookingDate: '2020-01-01',
      }),
    ).rejects.toThrow(/past/i);
  });

  it('refuses a booking with no project', async () => {
    await expect(
      prepareWriteTool(actor, 'create_booking', {
        leadId: 'L1',
        saleValue: 100,
        bookingDate: '2099-01-01',
      }),
    ).rejects.toThrow(/projectId is required/i);
  });

  it('flags a reassignment for extra caution', async () => {
    const action = await prepareWriteTool(actor, 'reassign_lead', { leadId: 'L1', userId: 'U2' });
    expect(action.warning).toBeTruthy();
  });

  it('rejects an unknown write tool', async () => {
    await expect(prepareWriteTool(actor, 'wipe_everything', {})).rejects.toThrow(/Unknown write tool/);
  });

  it('gives every prepared action a distinct id', async () => {
    const a = await prepareWriteTool(actor, 'add_lead_note', { leadId: 'L1', note: 'x' });
    const b = await prepareWriteTool(actor, 'add_lead_note', { leadId: 'L1', note: 'x' });
    expect(a.id).not.toBe(b.id);
  });
});

// ---------------------------------------------------------------------------
// Confirm-time validation
// ---------------------------------------------------------------------------

const actionFor = (over: Partial<PendingAction> & { tool: string }): PendingAction => ({
  id: 'A1',
  label: 'x',
  detail: [],
  target: { leadId: 'L1', leadName: 'Asha Verma' },
  payload: {},
  ...over,
});

describe('confirm-time validation', () => {
  it('accepts a well-formed action', () => {
    expect(() => validateActionShape(actionFor({ tool: 'create_followup' }))).not.toThrow();
  });

  it('rejects a reassignment with no target user', () => {
    expect(() =>
      validateActionShape(actionFor({ tool: 'reassign_lead', payload: {} })),
    ).toThrow(/target user/i);
  });

  it('rejects a booking with no positive sale value', () => {
    expect(() =>
      validateActionShape(actionFor({ tool: 'create_booking', payload: { saleValue: 'abc' } })),
    ).toThrow(/sale value/i);
  });

  it('rejects a booking whose date has already passed', () => {
    expect(() =>
      validateActionShape(
        actionFor({ tool: 'create_booking', payload: { saleValue: 100, bookingDate: '2001-01-01' } }),
      ),
    ).toThrow(/today or later/i);
  });

  it('rejects a status change with no target status', () => {
    expect(() =>
      validateActionShape(actionFor({ tool: 'change_lead_status', payload: {} })),
    ).toThrow(/target status/i);
  });

  it('rejects a note that lost its lead between proposing and confirming', () => {
    expect(() =>
      validateActionShape(actionFor({ tool: 'add_lead_note', target: {}, payload: {} })),
    ).toThrow(/not linked to a lead/i);
  });
});

// ---------------------------------------------------------------------------
// Loop bookkeeping (pure)
// ---------------------------------------------------------------------------

describe('trimHistory', () => {
  it('keeps only the most recent turns', () => {
    const h = Array.from({ length: 40 }, (_, i) => ({ role: 'user' as const, content: `m${i}` }));
    const out = trimHistory(h, 20);
    expect(out).toHaveLength(20);
    expect(out[0].content).toBe('m20');
    expect(out[19].content).toBe('m39');
  });

  it('drops blank turns the model produced', () => {
    const out = trimHistory([
      { role: 'assistant', content: 'real' },
      { role: 'assistant', content: '   ' },
      { role: 'user', content: '' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe('real');
  });

  it('defaults to a twenty-turn window', () => {
    const h = Array.from({ length: 30 }, () => ({ role: 'user' as const, content: 'x' }));
    expect(trimHistory(h)).toHaveLength(20);
  });

  it('leaves a short history alone', () => {
    const h = [
      { role: 'user' as const, content: 'a' },
      { role: 'assistant' as const, content: 'b' },
    ];
    expect(trimHistory(h)).toEqual(h);
  });

  it('drops the oldest turns once the character budget is blown', () => {
    // One huge table reply should not be allowed to evict everything useful.
    const h = [
      { role: 'user' as const, content: 'x'.repeat(1000) },
      { role: 'assistant' as const, content: 'y'.repeat(1000) },
      { role: 'user' as const, content: 'recent' },
    ];
    const out = trimHistory(h, 20, 100);
    expect(out).toEqual([{ role: 'user', content: 'recent' }]);
  });

  it('keeps the newest turns and never returns an empty tail for a fresh one', () => {
    const h = [{ role: 'user' as const, content: 'newest' }];
    expect(trimHistory(h, 20, 1)).toEqual(h);
  });
});

describe('retryDelayMs', () => {
  const res = (headers: Record<string, string>) => new Response(null, { headers });

  it('parses the wait Groq asks for out of the body', () => {
    const body =
      '{"error":{"message":"Rate limit reached ... Please try again in 11.415s. Need more tokens?"}}';
    expect(retryDelayMs(res({}), body)).toBe(11_415);
  });

  it('prefers the Retry-After header when present', () => {
    expect(retryDelayMs(res({ 'retry-after': '3' }), 'Please try again in 30s.')).toBe(3_000);
  });

  it('returns undefined when the provider gave no hint', () => {
    expect(retryDelayMs(res({}), 'Bad request: unknown tool')).toBeUndefined();
  });

  it('ignores a nonsense hint rather than sleeping zero', () => {
    expect(retryDelayMs(res({ 'retry-after': 'soon' }), '')).toBeUndefined();
  });

  it('clamps an absurd hint to 90s', () => {
    expect(retryDelayMs(res({ 'retry-after': '99999' }), '')).toBe(90_000);
  });
});

describe('dedupePending', () => {
  const base = actionFor({ tool: 'add_lead_note', id: 'A1', payload: { note: 'hi' } });

  it('drops an identical repeat of the same write', () => {
    const out = dedupePending([base, { ...base, id: 'A2' }]);
    expect(out).toHaveLength(1);
  });

  it('keeps genuinely different writes', () => {
    const other = { ...base, id: 'A3', payload: { note: 'different' } };
    expect(dedupePending([base, other])).toHaveLength(2);
  });

  it('keeps different tools on the same lead', () => {
    const other = { ...base, id: 'A4', tool: 'change_lead_status' };
    expect(dedupePending([base, other])).toHaveLength(2);
  });

  it('handles an empty list', () => {
    expect(dedupePending([])).toEqual([]);
  });
});
