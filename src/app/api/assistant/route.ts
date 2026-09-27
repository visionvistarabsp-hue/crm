import type { NextRequest } from 'next/server';
import { ApiError, json, readJson } from '@/lib/api';
import { withApi } from '@/lib/handlers';
import { isAiConfigured } from '@/lib/services/ai';
import { runAgent } from '@/lib/services/ai/agent';
import {
  appendMessage,
  getOrCreateConversation,
  listMessages,
  loadHistory,
} from '@/lib/services/assistantStore';
import { z } from 'zod';

const bodySchema = z.object({
  message: z.string().trim().min(1).max(4000),
  conversationId: z.string().uuid().optional().nullable(),
});

/**
 * Replay a thread for the drawer. With no id the most recent thread is used so
 * a page reload still shows the conversation. Ownership is enforced by the store.
 */
export const GET = withApi(async (actor, req: NextRequest) => {
  const conversationId = req.nextUrl.searchParams.get('conversationId');
  const conversation = await getOrCreateConversation(actor, conversationId);
  const messages = await listMessages(conversation.id);
  return { configured: isAiConfigured(), conversationId: conversation.id, messages };
});

export const POST = withApi(async (actor, req: NextRequest) => {
  const { message, conversationId } = bodySchema.parse(await readJson(req));

  if (!isAiConfigured()) {
    throw new ApiError(
      503,
      'AI is not configured on this server. Ask an admin to set GROQ_API_KEY.',
      'AI_NOT_CONFIGURED',
    );
  }

  const conversation = await getOrCreateConversation(actor, conversationId ?? null);
  const history = await loadHistory(conversation.id, 20);

  await appendMessage(conversation.id, { role: 'user', content: message });

  // A model/network failure after the user turn is saved must not lose the
  // message, so the throw here still leaves a replayable thread. The upstream
  // error is reported as 503 rather than an opaque 500 so the drawer can show
  // something the user can act on.
  let result;
  try {
    result = await runAgent(actor, message, history);
  } catch (err) {
    console.error('[assistant] agent run failed', err);
    throw new ApiError(
      503,
      'The AI provider is not responding right now. Your message was saved — try again in a moment.',
      'AI_UNAVAILABLE',
    );
  }

  const saved = await appendMessage(conversation.id, {
    role: 'assistant',
    content: result.reply,
    pendingActions: result.pendingActions,
    model: 'groq',
  });

  return {
    conversationId: conversation.id,
    reply: saved,
    steps: result.steps,
    capped: result.capped,
    usage: result.usage,
  };
});
