import { NextRequest } from 'next/server';
import { ApiError, readJson } from '@/lib/api';
import { withApi } from '@/lib/handlers';
import { applyConfirmedActions } from '@/lib/services/ai/confirm';
import {
  clearPending,
  getOrCreateConversation,
  listMessages,
} from '@/lib/services/assistantStore';
import type { PendingAction } from '@/lib/services/ai/tools';
import { z } from 'zod';

const confirmSchema = z.object({
  conversationId: z.string().uuid(),
  actionIds: z.array(z.string().uuid()).min(1).max(20),
});

/**
 * Apply the exact cards the user clicked. The action ids are resolved against
 * the stored pending list, so a client cannot invent a payload.
 */
export const POST = withApi(async (actor, req: NextRequest) => {
  const { conversationId, actionIds } = confirmSchema.parse(await readJson(req));

  const conversation = await getOrCreateConversation(actor, conversationId);
  if (conversation.id !== conversationId) throw new ApiError(404, 'Conversation not found');

  const messages = await listMessages(conversationId, 200);
  const pending = messages.flatMap((m) => m.pendingActions) as PendingAction[];
  if (pending.length === 0) {
    throw new ApiError(409, 'These actions were already confirmed or discarded.', 'ALREADY_RESOLVED');
  }

  const outcomes = await applyConfirmedActions(actor, pending, actionIds);

  // Anything left over was not chosen; drop the whole set so cards do not linger.
  await clearPending(conversationId, actor.user.id);

  return { outcomes };
});

/** Discard every pending card in the thread. */
export const DELETE = withApi(async (actor, req: NextRequest) => {
  const { conversationId } = z.object({ conversationId: z.string().uuid() }).parse(await readJson(req));
  await getOrCreateConversation(actor, conversationId);
  await clearPending(conversationId, actor.user.id);
  return { ok: true };
});
