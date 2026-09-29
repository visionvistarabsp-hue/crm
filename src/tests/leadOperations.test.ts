import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `getLeadOperations` composes one lead's operational snapshot and timeline
 * from seven + tables. These tests mock the DB entirely and pin the contracts:
 *
 *   - the summary tiles: earliest PENDING follow-up (+ overdue count),
 *     site-visit completion/next date, latest non-cancelled booking,
 *     latest AGREEMENT document, and money collected across the lead's
 *     bookings (never double-counting, never including bounced/reversed);
 *   - the timeline: merged reverse-chronological feed that uses each source
 *     table ONCE — the auto-penned `lead_activities` rows whose source entity
 *     has its own table are skipped so nothing shows twice;
 *   - visibility: non-visible leads 404 through `canAccessLead`.
 */

let visibleOwnerIds: string[] | null = null;
let leadRow: Record<string, unknown> | undefined;
let followupRows: Record<string, unknown>[] = [];
let meetingRows: Record<string, unknown>[] = [];
let bookingRows: Record<string, unknown>[] = [];
let paymentRows: Record<string, unknown>[] = [];
let documentRows: Record<string, unknown>[] = [];
let activityRows: Record<string, unknown>[] = [];
let statusHistoryRows: Record<string, unknown>[] = [];
let messageRows: Array<Record<string, unknown>> | undefined;
/** Payments query never runs when the lead has no bookings. */
let paymentsQueried = false;
/** shared across the list + count queries inside listOutboundMessages */
let whereCallN = 0;

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    resolveVisibleUserIds: vi.fn(async () => visibleOwnerIds),
  };
});

vi.mock('@/lib/db', () => ({
  db: {
    query: {
      leads: {
        findFirst: async () => leadRow,
      },
      followups: { findMany: async () => followupRows },
      meetings: { findMany: async () => meetingRows },
      bookings: { findMany: async () => bookingRows },
      payments: {
        findMany: async () => {
          paymentsQueried = true;
          return paymentRows;
        },
      },
      documents: { findMany: async () => documentRows },
      leadActivities: { findMany: async () => activityRows },
      leadStatusHistory: { findMany: async () => statusHistoryRows },
    },
    select: () => ({
      from: () => {
        const where = (w: unknown) => {
          whereCallN += 1;
          if (whereCallN === 1) {
            // list query: select(...).from(...).leftJoin().leftJoin().where().orderBy().limit().offset()
            return { orderBy: () => ({ limit: () => ({ offset: async () => messageRows ?? [] }) }) };
          }
          // count query: select(...).from(...).where().then()
          return { then: async (fn: (r: unknown[]) => unknown) => fn(messageRows ?? []) };
        };
        const leftJoin = () => ({ leftJoin, where });
        return { leftJoin, where };
      },
    }),
  },
}));

const { getLeadOperations } = await import('@/lib/services/leadOperations');
const { ApiError } = await import('@/lib/api');

const actor = { user: { id: 'u1', role: 'SUPER_ADMIN' } };

const T = {
  nova: '2026-09-29T10:00:00.000Z',
  old: '2026-08-01T10:00:00.000Z',
  older: '2026-07-01T10:00:00.000Z',
};

beforeEach(() => {
  visibleOwnerIds = null;
  leadRow = { id: 'lead-1', leadNo: 'LD-001', name: 'Riya Shah', status: 'FOLLOW_UP', ownerId: 'u-owner' };
  followupRows = [];
  meetingRows = [];
  bookingRows = [];
  paymentRows = [];
  documentRows = [];
  activityRows = [];
  statusHistoryRows = [];
  messageRows = undefined;
  paymentsQueried = false;
  whereCallN = 0;
});

describe('getLeadOperations visibility', () => {
  it('404s when the lead is not visible to the actor', async () => {
    visibleOwnerIds = ['u-other'];
    await expect(getLeadOperations(actor as never, 'lead-1')).rejects.toThrow(ApiError);
  });

  it('404s when the lead does not exist', async () => {
    leadRow = undefined;
    await expect(getLeadOperations(actor as never, 'missing')).rejects.toThrow(ApiError);
  });
});

describe('getLeadOperations summary', () => {
  it('picks the earliest PENDING follow-up and counts overdue ones', async () => {
    followupRows = [
      { id: 'f1', type: 'CALL', notes: null, scheduledAt: new Date('2026-10-02T09:00:00.000Z'), status: 'PENDING' },
      { id: 'f2', type: 'WHATSAPP', notes: 'ping', scheduledAt: new Date('2026-10-01T09:00:00.000Z'), status: 'PENDING' },
      { id: 'f3', type: 'CALL', notes: null, scheduledAt: new Date('2026-09-20T09:00:00.000Z'), status: 'PENDING' },
      { id: 'f4', type: 'CALL', notes: null, scheduledAt: new Date('2026-09-01T09:00:00.000Z'), status: 'COMPLETED' },
    ];

    const { summary } = await getLeadOperations(actor as never, 'lead-1');
    expect(summary.nextFollowup).toMatchObject({ id: 'f2', status: 'PENDING' });
    expect(summary.nextFollowup?.scheduledAt).toBe('2026-10-01T09:00:00.000Z');
    // f3 is the only PENDING row already past; f4 COMPLETED is not overdue; f1/f2 are upcoming
    expect(summary.overdueCount).toBe(1);
  });

  it('summarises site visits: completed count + next scheduled date', async () => {
    meetingRows = [
      { id: 'm1', type: 'SITE_VISIT', visitNumber: 1, scheduledAt: new Date(T.old), status: 'COMPLETED' },
      { id: 'm2', type: 'SITE_VISIT', visitNumber: 2, scheduledAt: new Date('2026-10-05T11:00:00.000Z'), status: 'SCHEDULED' },
      { id: 'm3', type: 'SITE_VISIT', visitNumber: 3, scheduledAt: new Date('2026-11-01T11:00:00.000Z'), status: 'CONFIRMED' },
      { id: 'm4', type: 'MEETING', scheduledAt: new Date('2026-10-01T11:00:00.000Z'), status: 'CONFIRMED' },
    ];

    const { summary } = await getLeadOperations(actor as never, 'lead-1');
    expect(summary.visits.completed).toBe(1);
    expect(summary.visits.nextScheduledAt).toBe('2026-10-05T11:00:00.000Z');
  });

  it('reports the most recent non-cancelled booking', async () => {
    bookingRows = [
      { id: 'b1', bookingNo: 'BK-001', bookingDate: new Date(T.old), saleValue: '4500000', status: 'CANCELLED' },
      { id: 'b2', bookingNo: 'BK-002', bookingDate: new Date(T.nova), saleValue: '5200000', status: 'CONFIRMED' },
    ];
    const { summary } = await getLeadOperations(actor as never, 'lead-1');
    expect(summary.booking).toMatchObject({ id: 'b2', bookingNo: 'BK-002', status: 'CONFIRMED' });
  });

  it('returns the latest AGREEMENT document verification status', async () => {
    documentRows = [
      { id: 'd1', documentType: 'BOOKING_FORM', title: 'Booking form', fileName: 'bf.pdf', verificationStatus: 'VERIFIED', createdAt: new Date(T.old) },
      { id: 'd2', documentType: 'AGREEMENT', title: 'Agreement', fileName: 'ag.pdf', verificationStatus: 'PENDING', createdAt: new Date(T.older) },
      { id: 'd3', documentType: 'AGREEMENT', title: 'Agreement v2', fileName: 'ag2.pdf', verificationStatus: 'VERIFIED', createdAt: new Date(T.nova) },
    ];
    const { summary } = await getLeadOperations(actor as never, 'lead-1');
    expect(summary.agreement).toMatchObject({ id: 'd3', verificationStatus: 'VERIFIED' });
    expect(summary.agreement?.fileName).toBe('ag2.pdf');
  });

  it('totals money collected across the lead bookings, excluding bounced/reversed', async () => {
    bookingRows = [{ id: 'b1', bookingNo: 'BK-001', bookingDate: new Date(T.old), saleValue: '4500000', status: 'CONFIRMED' }];
    paymentRows = [
      { id: 'p1', bookingId: 'b1', amount: '1500000', paymentDate: new Date('2026-09-10T00:00:00.000Z'), status: 'RECEIVED' },
      { id: 'p2', bookingId: 'b1', amount: '500000', paymentDate: new Date('2026-09-11T00:00:00.000Z'), status: 'BOUNCED' },
      { id: 'p3', bookingId: 'b1', amount: '2000000', paymentDate: new Date('2026-09-12T00:00:00.000Z'), status: 'RECEIVED' },
      { id: 'p4', bookingId: 'b1', amount: '100000', paymentDate: new Date('2026-09-13T00:00:00.000Z'), status: 'REVERSED' },
    ];
    const { summary } = await getLeadOperations(actor as never, 'lead-1');
    expect(summary.amountCollected).toBe(3500000);
    expect(paymentsQueried).toBe(true);
  });

  it('does not query payments when the lead has no bookings', async () => {
    const { summary } = await getLeadOperations(actor as never, 'lead-1');
    expect(summary.booking).toBeNull();
    expect(summary.amountCollected).toBe(0);
    expect(paymentsQueried).toBe(false);
  });
});

describe('getLeadOperations timeline', () => {
  it('merges every source into a reverse-chronological feed', async () => {
    followupRows = [{ id: 'f1', type: 'CALL', notes: null, scheduledAt: new Date('2026-09-28T09:00:00.000Z'), status: 'PENDING' }];
    meetingRows = [{ id: 'm1', type: 'SITE_VISIT', visitNumber: 2, scheduledAt: new Date('2026-09-27T11:00:00.000Z'), status: 'COMPLETED', location: 'Site', notes: null }];
    bookingRows = [{ id: 'b1', bookingNo: 'BK-001', bookingDate: new Date('2026-09-26T00:00:00.000Z'), saleValue: '4500000', status: 'CONFIRMED' }];
    paymentRows = [{ id: 'p1', bookingId: 'b1', amount: '1500000', paymentDate: new Date('2026-09-25T00:00:00.000Z'), status: 'RECEIVED' }];
    documentRows = [{ id: 'd1', documentType: 'AGREEMENT', title: 'Agreement', fileName: 'ag.pdf', verificationStatus: 'VERIFIED', createdAt: new Date('2026-09-24T00:00:00.000Z') }];
    statusHistoryRows = [{ id: 'h1', fromStatus: 'CONTACTED', toStatus: 'FOLLOW_UP', createdAt: new Date('2026-09-23T00:00:00.000Z') }];
    activityRows = [
      { id: 'a1', type: 'NOTE', note: 'Called the client', performedById: 'u1', createdAt: new Date('2026-09-22T00:00:00.000Z') },
      // auto-penned rows whose source tables already contribute events:
      { id: 'a2', type: 'FOLLOWUP_CREATED', note: 'Follow-up scheduled (CALL)', createdAt: new Date('2026-09-21T00:00:00.000Z') },
      { id: 'a3', type: 'STATUS_CHANGE', note: 'Status moved', createdAt: new Date('2026-09-20T00:00:00.000Z') },
    ];
    messageRows = [
      { id: 'log-1', channel: 'EMAIL', recipient: 'riya@example.com', subject: 'Site visit reminder', bodyText: null, status: 'SENT', leadId: 'lead-1', leadName: 'Riya Shah', userId: 'u1', userName: 'Aarti', error: null, createdAt: new Date('2026-09-30T08:00:00.000Z') },
    ];

    const { timeline } = await getLeadOperations(actor as never, 'lead-1');

    // newest first; the two auto-penned activities are absent
    expect(timeline.map((e) => e.kind)).toEqual([
      'MESSAGE',
      'FOLLOWUP',
      'SITE_VISIT',
      'BOOKING',
      'PAYMENT',
      'DOCUMENT',
      'STATUS_CHANGE',
      'NOTE',
    ]);
    expect(timeline[0]).toMatchObject({ title: 'EMAIL sent', detail: 'Site visit reminder · riya@example.com', actorName: 'Aarti' });
    expect(timeline.find((e) => e.kind === 'SITE_VISIT')).toMatchObject({ title: 'Site visit #2', status: 'COMPLETED' });
    expect(timeline.find((e) => e.kind === 'STATUS_CHANGE')).toMatchObject({ detail: 'CONTACTED → FOLLOW_UP' });
  });

  it('maps MEETING rows to their own kind and keeps a rescheduled visit scheduled', async () => {
    meetingRows = [
      { id: 'm1', type: 'MEETING', title: 'First discussion', scheduledAt: new Date('2026-09-27T11:00:00.000Z'), status: 'CONFIRMED', location: null, notes: null },
      { id: 'm2', type: 'SITE_VISIT', visitNumber: 1, scheduledAt: new Date('2026-10-02T11:00:00.000Z'), status: 'RESCHEDULED', location: null, notes: null },
    ];
    const { summary, timeline } = await getLeadOperations(actor as never, 'lead-1');

    expect(summary.visits.nextScheduledAt).toBe('2026-10-02T11:00:00.000Z');
    expect(timeline.find((e) => e.id === 'm1')).toMatchObject({ kind: 'MEETING', title: 'First discussion' });
    expect(timeline.find((e) => e.id === 'm2')).toMatchObject({ kind: 'SITE_VISIT', title: 'Site visit #1' });
  });

  it('sorts equal timestamps stably by input order', async () => {
    followupRows = [{ id: 'f1', type: 'CALL', notes: null, scheduledAt: new Date(T.nova), status: 'PENDING' }];
    activityRows = [{ id: 'a1', type: 'NOTE', note: 'same instant', createdAt: new Date(T.nova) }];
    const { timeline } = await getLeadOperations(actor as never, 'lead-1');
    // follow-up events are pushed before activities of the same instant
    expect(timeline.map((e) => e.kind)).toEqual(['FOLLOWUP', 'NOTE']);
  });

  it('returns an empty feed when there is nothing on the lead', async () => {
    const { timeline, summary } = await getLeadOperations(actor as never, 'lead-1');
    expect(timeline).toEqual([]);
    expect(summary.visits.completed).toBe(0);
    expect(summary.nextFollowup).toBeNull();
  });
});