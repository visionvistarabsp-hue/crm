/**
 * Conversation persistence for the assistant.
 *
 * Every query is scoped to `userId`, so one user can never read another user's
 * transcript - not even by guessing a conversation id.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { ApiError, type Actor } from '@/lib/api';
import { db } from '@/lib/db';
import { assistantConversations, assistantMessages } from '@/lib/db/schema';
import type { ChatMessage } from './ai/agent';
import type { PendingAction } from './ai/tools';

export interface StoredMessage {
  id: string;
  role: string;
  content: string;
  pendingActions: PendingAction[];
  model: string | null;
  createdAt: Date;
}

function toStored(row: typeof assistantMessages.$inferSelect): StoredMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    pendingActions: (row.pendingActions ?? []) as PendingAction[],
    model: row.model,
    createdAt: row.createdAt,
  };
}

export async function listConversations(userId: string) {
  return db
    .select({
      id: assistantConversations.id,
      title: assistantConversations.title,
      createdAt: assistantConversations.createdAt,
      updatedAt: assistantConversations.updatedAt,
    })
    .from(assistantConversations)
    .where(
      and(
        eq(assistantConversations.userId, userId),
        sql`${assistantConversations.archivedAt} is null`,
      ),
    )
    .orderBy(desc(assistantConversations.updatedAt))
    .limit(50);
}

/** Most recent conversation for the user, creating one on demand. */
export async function getOrCreateConversation(actor: Actor, conversationId?: string | null) {
  if (conversationId) {
    const found = await db
      .select()
      .from(assistantConversations)
      .where(
        and(
          eq(assistantConversations.id, conversationId),
          eq(assistantConversations.userId, actor.user.id),
        ),
      )
      .limit(1);
    if (found[0]) return found[0];
    // A wrong id is a client bug or a probe for someone else's thread.
    throw new ApiError(404, 'Conversation not found', 'NOT_FOUND');
  }

  const existing = await db
    .select()
    .from(assistantConversations)
    .where(
      and(
        eq(assistantConversations.userId, actor.user.id),
        sql`${assistantConversations.archivedAt} is null`,
      ),
    )
    .orderBy(desc(assistantConversations.updatedAt))
    .limit(1);
  if (existing[0]) return existing[0];

  const created = await db
    .insert(assistantConversations)
    .values({ userId: actor.user.id, title: 'New chat' })
    .returning();
  return created[0];
}

export async function appendMessage(
  conversationId: string,
  row: {
    role: 'user' | 'assistant';
    content: string;
    pendingActions?: PendingAction[];
    model?: string | null;
  },
): Promise<StoredMessage> {
  const inserted = await db
    .insert(assistantMessages)
    .values({
      conversationId,
      role: row.role,
      content: row.content,
      pendingActions: row.pendingActions ?? null,
      model: row.model ?? null,
    })
    .returning();
  await db
    .update(assistantConversations)
    .set({ updatedAt: new Date() })
    .where(eq(assistantConversations.id, conversationId));
  return toStored(inserted[0]);
}

export async function listMessages(conversationId: string, limit = 100): Promise<StoredMessage[]> {
  const rows = await db
    .select()
    .from(assistantMessages)
    .where(eq(assistantMessages.conversationId, conversationId))
    .orderBy(assistantMessages.createdAt)
    .limit(limit);
  return rows.map(toStored);
}

/** Prior turns in the shape the agent wants for context. */
export async function loadHistory(conversationId: string, max = 20): Promise<ChatMessage[]> {
  const rows = await db
    .select({ role: assistantMessages.role, content: assistantMessages.content })
    .from(assistantMessages)
    .where(eq(assistantMessages.conversationId, conversationId))
    .orderBy(desc(assistantMessages.createdAt))
    .limit(max);
  return rows.reverse().map((r) => ({ role: r.role === 'assistant' ? 'assistant' : 'user', content: r.content }));
}

/** Clear pending cards once the user has confirmed or discarded them. */
export async function clearPending(conversationId: string, userId: string): Promise<void> {
  await db
    .update(assistantMessages)
    .set({ pendingActions: sql`'[]'::jsonb` })
    .where(
      and(
        eq(assistantMessages.conversationId, conversationId),
        sql`exists (
          select 1 from ${assistantConversations}
          where ${assistantConversations.id} = ${assistantMessages.conversationId}
            and ${assistantConversations.userId} = ${userId}
        )`,
      ),
    );
}
