import { and, desc, eq } from 'drizzle-orm';
import { db } from './db';
import { leads, messageLogs, users } from './db/schema';

/**
 * Outbound message history.
 *
 * This is deliberately separate from the queue: `background_jobs` proves a
 * job was queued and ran, but nothing recorded what was actually said to whom
 * and whether the provider accepted it. `message_logs` is the human-readable
 * record of every email / WhatsApp send, appended best-effort by the send
 * handlers. `logOutboundMessage` never throws - a storage error must not turn
 * a sent message into a retried one, or a send failure into a silent gap.
 */

export type MessageLogChannel = 'EMAIL' | 'WHATSAPP';
export type MessageLogStatus = 'SENT' | 'FAILED';

export interface MessageLogInput {
  channel: MessageLogChannel;
  recipient: string;
  subject?: string | null;
  bodyText?: string | null;
  status: MessageLogStatus;
  providerMessageId?: string | null;
  leadId?: string | null;
  userId?: string | null;
  error?: string | null;
}

/** Guards against huge bodies (lead digests can run long) bloating the row. */
const MAX_BODY_CHARS = 4000;

export async function logOutboundMessage(input: MessageLogInput): Promise<void> {
  try {
    await db.insert(messageLogs).values({
      channel: input.channel,
      recipient: input.recipient,
      subject: input.subject?.trim().slice(0, 255) || null,
      bodyText: input.bodyText?.trim().slice(0, MAX_BODY_CHARS) || null,
      status: input.status,
      providerMessageId: input.providerMessageId ?? null,
      leadId: input.leadId ?? null,
      userId: input.userId ?? null,
      error: input.error?.slice(0, 1000) ?? null,
    });
  } catch (err) {
    // Best-effort by contract: the send already happened (or failed) and must
    // not be re-run or hidden because the record could not be written.
    console.error('[messageLog] failed to persist outbound message log', err);
  }
}

export interface MessageLogView {
  id: string;
  channel: MessageLogChannel;
  recipient: string;
  subject: string | null;
  bodyText: string | null;
  status: MessageLogStatus;
  providerMessageId: string | null;
  leadId: string | null;
  leadName: string | null;
  userId: string | null;
  userName: string | null;
  error: string | null;
  createdAt: Date;
}

export interface ListMessageLogsOptions {
  channel?: MessageLogChannel | null;
  leadId?: string | null;
  limit?: number;
  offset?: number;
}

/** Newest first; joins resolve the recipient's lead / user name for display. */
export async function listOutboundMessages(
  options: ListMessageLogsOptions = {},
): Promise<{ items: MessageLogView[]; total: number }> {
  const conditions: ReturnType<typeof eq>[] = [];
  if (options.channel) conditions.push(eq(messageLogs.channel, options.channel));
  if (options.leadId) conditions.push(eq(messageLogs.leadId, options.leadId));

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);

  const rows = await db
    .select({
      id: messageLogs.id,
      channel: messageLogs.channel,
      recipient: messageLogs.recipient,
      subject: messageLogs.subject,
      bodyText: messageLogs.bodyText,
      status: messageLogs.status,
      providerMessageId: messageLogs.providerMessageId,
      leadId: messageLogs.leadId,
      leadName: leads.name,
      userId: messageLogs.userId,
      userName: users.name,
      error: messageLogs.error,
      createdAt: messageLogs.createdAt,
    })
    .from(messageLogs)
    .leftJoin(leads, eq(messageLogs.leadId, leads.id))
    .leftJoin(users, eq(messageLogs.userId, users.id))
    .where(where)
    .orderBy(desc(messageLogs.createdAt))
    .limit(limit)
    .offset(offset);

  const count = await db
    .select({ value: messageLogs.id })
    .from(messageLogs)
    .where(where)
    .then((r) => r.length);

  return {
    items: rows.map((row) => ({
      ...row,
      channel: row.channel as MessageLogChannel,
      status: row.status as MessageLogStatus,
    })),
    total: count,
  };
}