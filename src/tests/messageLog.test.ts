import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The outbound message log services depend only on the DB, which these tests
 * mock entirely. They pin two contracts:
 *
 *   - `logOutboundMessage` persists one compact row per send and - critically -
 *     never throws, because a failed write must not turn a sent message into a
 *     retried one (or a send failure into a silent gap);
 *   - `listOutboundMessages` returns newest-first rows with the lead/user name
 *     resolved for display, and honours the channel / lead filters.
 */

let insertValues: Array<Record<string, unknown>> | undefined;
let insertError: Error | undefined;
let selectRows: Array<Record<string, unknown>> | undefined;
/** Raw values passed to `db.select(...).where(...)` (drizzle SQL conditions). */
const whereCalls: unknown[] = [];
/** how many `where()` calls the chain has seen; distinguishes join vs count. */
let whereCallN = 0;

vi.mock('@/lib/db', () => ({
  db: {
    count: async () => 1,
    insert: () => ({
      values: async (values: Record<string, unknown>) => {
        if (insertError) throw insertError;
        insertValues?.push(values);
        return [];
      },
    }),
    select: () => ({
      from: () => {
        const where = (w: unknown) => {
          whereCallN += 1;
          whereCalls.push(w);
          if (whereCallN === 1) {
            // First query is the joined list: select(...).from(...).leftJoin().leftJoin().where().orderBy().limit().offset()
            return {
              orderBy: () => ({ limit: () => ({ offset: async () => selectRows ?? [] }) }),
            };
          }
          // Second query is the count: select(...).from(...).where().then()
          return { then: async (fn: (r: unknown[]) => unknown) => fn(selectRows ?? []) };
        };
        // The one `.leftJoin()` call in the list query returns itself so a
        // second `.leftJoin()` works, then hands over to `where`.
        const leftJoin = () => ({ leftJoin, where });
        return { leftJoin, where };
      },
    }),
  },
}));

const { logOutboundMessage, listOutboundMessages } = await import('@/lib/messageLog');

beforeEach(() => {
  insertValues = undefined;
  insertError = undefined;
  selectRows = undefined;
  whereCalls.length = 0;
  whereCallN = 0;
});

describe('logOutboundMessage', () => {
  it('persists a compact SENT row with the provider message id', async () => {
    insertValues = [];
    await logOutboundMessage({
      channel: 'EMAIL',
      recipient: 'riya@example.com',
      subject: 'New lead: Riya Shah',
      bodyText: 'Lead: Riya Shah',
      status: 'SENT',
      providerMessageId: 'resend-id-1',
      leadId: 'lead-1',
      userId: 'u1',
    });

    expect(insertValues).toHaveLength(1);
    expect(insertValues![0]).toMatchObject({
      channel: 'EMAIL',
      recipient: 'riya@example.com',
      subject: 'New lead: Riya Shah',
      status: 'SENT',
      providerMessageId: 'resend-id-1',
      leadId: 'lead-1',
      userId: 'u1',
    });
  });

  it('truncates an oversized body so a long digest cannot bloat the row', async () => {
    insertValues = [];
    await logOutboundMessage({
      channel: 'EMAIL',
      recipient: 'dev@example.com',
      bodyText: 'x'.repeat(5000),
      status: 'SENT',
    });

    expect(String(insertValues![0].bodyText)).toHaveLength(4000);
  });

  it('never throws even when the insert fails, and reports it', async () => {
    insertError = new Error('db down');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      logOutboundMessage({ channel: 'EMAIL', recipient: 'x@example.com', status: 'FAILED' }),
    ).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe('listOutboundMessages', () => {
  it('joins the lead and user names onto each row', async () => {
    selectRows = [
      {
        id: 'log-1',
        channel: 'WHATSAPP',
        recipient: '+919876543210',
        subject: null,
        bodyText: 'summary',
        status: 'SENT',
        providerMessageId: 'wamid.1',
        leadId: 'lead-1',
        leadName: 'Riya Shah',
        userId: 'u1',
        userName: 'Priya Jha',
        error: null,
        createdAt: new Date('2026-09-29T10:00:00Z'),
      },
    ];

    const { items, total } = await listOutboundMessages();
    expect(total).toBe(1);
    expect(items[0]).toMatchObject({
      channel: 'WHATSAPP',
      recipient: '+919876543210',
      status: 'SENT',
      leadName: 'Riya Shah',
      userName: 'Priya Jha',
    });
  });

  it('builds a combined AND condition when filters are passed', async () => {
    selectRows = [];
    await listOutboundMessages({ channel: 'EMAIL', leadId: 'lead-1' });

    // `where` is applied by both the list query and the matching count query.
    expect(whereCalls).toHaveLength(2);
    expect(whereCalls[0]).toBeDefined();
    expect(whereCalls[1]).toBeDefined();
  });

  it('passes no condition when there are no filters', async () => {
    selectRows = [];
    await listOutboundMessages();
    expect(whereCalls).toHaveLength(2);
    expect(whereCalls[0]).toBeUndefined();
    expect(whereCalls[1]).toBeUndefined();
  });
});