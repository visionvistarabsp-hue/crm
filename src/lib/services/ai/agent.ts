/**
 * The assistant agent: a bounded tool-calling loop against Groq.
 *
 * Read tools execute inline and their JSON result is fed back so the model can
 * reason over real rows. Write tools are prepared (validated + resolved) but
 * never executed - they become `PendingAction` confirm cards and the tool
 * result tells the model the write is queued. Nothing reaches the database
 * until `confirm.ts` runs after an explicit user click.
 */
import type { Actor } from '@/lib/api';
import type { CurrentUser } from '@/lib/auth';
import { aiConfig } from '../ai';
import {
  groqTools,
  prepareWriteTool,
  readToolCall,
  runReadTool,
  toolKind,
  type PendingAction,
} from './tools';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MAX_STEPS = 5;
const MAX_TOKENS = 2000;
const TIMEOUT_MS = 45_000;
/**
 * Whole-turn wall clock, covering every step and every retry. Long enough for
 * one full rate-limit window to clear, short enough that a stuck provider does
 * not leave the user on a spinner indefinitely.
 */
const TOTAL_BUDGET_MS = 120_000;
const TEMPERATURE = 0.2;
/** Transient upstream statuses worth one more attempt. */
const RETRY_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentResult {
  reply: string;
  pendingActions: PendingAction[];
  steps: number;
  /** True when the step cap was hit before the model settled on an answer. */
  capped: boolean;
  usage: { totalTokens: number };
}

interface GroqToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface GroqResponse {
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null; reasoning?: string | null; tool_calls?: GroqToolCall[] };
  }>;
  usage?: { total_tokens?: number };
}

/**
 * Cap how much prior context is replayed, by turn count *and* by characters.
 * Pure - unit tested.
 *
 * The character cap is what keeps the request inside the provider's per-minute
 * token budget: one long tabular reply can outweigh a dozen short turns, and a
 * request that trips the rate limit fails the whole turn.
 */
export function trimHistory(history: ChatMessage[], max = 20, maxChars = 6_000): ChatMessage[] {
  const clean = history.filter((m) => typeof m?.content === 'string' && m.content.trim() !== '');
  const out: ChatMessage[] = [];
  let total = 0;
  for (let i = clean.length - 1; i >= 0; i--) {
    const len = clean[i].content.length;
    // The newest turn is always kept, even alone over budget: an empty history
    // loses all continuity, whereas one long turn costs only a few tokens.
    const overBudget = out.length > 0 && total + len > maxChars;
    if (out.length >= max || overBudget) break;
    out.unshift(clean[i]);
    total += len;
  }
  return out;
}

/** Drop repeat proposals of the same write so the user is not asked twice. Pure. */
export function dedupePending(actions: PendingAction[]): PendingAction[] {
  const seen = new Set<string>();
  const out: PendingAction[] = [];
  for (const a of actions) {
    const key = `${a.tool}:${a.target.leadId ?? ''}:${JSON.stringify(a.payload)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

function systemPrompt(user: CurrentUser, now: Date): string {
  const hour = now.getUTCHours();
  const partOfDay = hour < 4 ? 'late night' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  return `You are the sales assistant inside a real-estate CRM (India). You help the logged-in user with their own visible records.

Current date and time (UTC): ${now.toISOString()}
It is currently ${partOfDay}. Interpret "today", "tomorrow", "next week" against the timestamp above.
User: ${user.name} (${user.role}).

RULES - these are strict:
1. Never invent data. Every fact must come from a tool result. If a tool did not return it, say it is not recorded.
2. Never guess a lead id, user id, project id or unit id. Use search_leads / get_lead to resolve them first. If you cannot resolve a target, ask the user instead of guessing.
3. Writing is a two-step contract. Call the write tool, then STOP and summarise what you are about to do. The system shows the user a confirmation card. You cannot write anything directly.
4. After calling a write tool you will be told it is "awaiting_user_confirmation". Do not call that same tool again for the same request.
5. Each write tool takes one action. If the user asked for several actions, call the tools one at a time, then summarise all of them together at the end.
6. Only use write tools the current user is actually allowed to use. If a tool returns an error, explain it plainly and stop.
7. Keep replies short and concrete - the user is a busy salesperson. No filler, no restating the question. Use a few short lines or a compact list.
8. Use rupee amounts as "Rs 1.25 Cr" / "Rs 85,000" style when the number is large.
9. If the user's question needs data, call a read tool first. Do not answer from assumptions.

Available data: leads with timeline and follow-ups, follow-up tasks, meetings and site visits, bookings, projects and units, and the team directory.`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * How long the provider asked us to wait before retrying.
 *
 * This matters more than it looks: Groq's free tier is 8000 tokens/minute and a
 * single tool-calling request is ~4.8k tokens, so the window is roughly a
 * minute. A fixed 1s/2s backoff would burn every attempt inside the same
 * window and the user would just see a failure. Honouring the number the
 * provider actually sends is the difference between recovering and not.
 */
export function retryDelayMs(res: Response, body: string): number | undefined {
  const header = res.headers.get('retry-after');
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, 90_000);
  }
  // Groq phrases it in the body: "Please try again in 11.415s."
  const m = /try again in\s+([\d.]+)\s*s/i.exec(body);
  if (m) {
    const ms = Number(m[1]) * 1000;
    if (Number.isFinite(ms) && ms > 0) return Math.min(ms, 90_000);
  }
  return undefined;
}

/**
 * One attempt. `budget` carries the per-request deadline so retries cannot
 * multiply into an unbounded wait for the user.
 */
async function callGroqOnce(
  cfg: { key: string; model: string },
  messages: unknown[],
  budget: { left: number },
): Promise<GroqResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, budget.left));
  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({
        model: cfg.model,
        temperature: TEMPERATURE,
        max_tokens: MAX_TOKENS,
        messages,
        tools: groqTools(),
        tool_choice: 'auto',
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw Object.assign(new Error(`Groq ${res.status}: ${body.slice(0, 300)}`), {
        status: res.status as number,
        retryAfterMs: retryDelayMs(res, body),
      });
    }
    return (await res.json()) as GroqResponse;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call Groq, retrying only statuses that are actually transient. A 400 from a
 * malformed tool call is surfaced immediately - retrying it would just burn
 * the user's time.
 */
async function callGroq(
  cfg: { key: string; model: string },
  messages: unknown[],
  deadline: number,
): Promise<GroqResponse> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    try {
      return await callGroqOnce(cfg, messages, { left });
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number })?.status;
      const retryable = status === undefined || RETRY_STATUSES.has(status);
      if (!retryable || attempt === MAX_ATTEMPTS) break;
      // Prefer the provider's own hint; fall back to 1s, 2s. Never sleep past
      // the deadline, and never wait longer than it is worth waiting.
      const hinted = (err as { retryAfterMs?: number })?.retryAfterMs;
      const wait = Math.min(hinted ?? 1000 * 2 ** (attempt - 1), deadline - Date.now());
      if (wait <= 0) break;
      await sleep(wait);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('The AI provider did not respond');
}

/**
 * Run one user turn. `history` is the prior transcript (trimmed internally).
 */
export async function runAgent(
  actor: Actor,
  userText: string,
  history: ChatMessage[] = [],
  now: Date = new Date(),
): Promise<AgentResult> {
  const cfg = aiConfig();
  if (!cfg) throw new Error('AI is not configured on this server.');

  const messages: unknown[] = [
    { role: 'system', content: systemPrompt(actor.user, now) },
    ...trimHistory(history).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userText },
  ];

  const pending: PendingAction[] = [];
  let totalTokens = 0;
  let steps = 0;
  let capped = false;
  let lastText = '';
  // One wall-clock budget for the whole turn, so a retry storm cannot leave the
  // user staring at a spinner.
  const deadline = now.getTime() + TOTAL_BUDGET_MS;

  while (steps < MAX_STEPS) {
    steps += 1;
    const data = await callGroq(cfg, messages, deadline);
    totalTokens += data.usage?.total_tokens ?? 0;

    const choice = data.choices?.[0];
    const msg = choice?.message;
    const toolCalls = msg?.tool_calls ?? [];
    const text = (msg?.content ?? '').trim();
    if (text) lastText = text;

    // No tool calls -> the model is done talking.
    if (toolCalls.length === 0) {
      return {
        reply: text || lastText || 'I could not produce an answer for that.',
        pendingActions: dedupePending(pending),
        steps,
        capped: false,
        usage: { totalTokens },
      };
    }

    if (choice?.finish_reason === 'length') {
      capped = true;
      break;
    }

    messages.push({
      role: 'assistant',
      content: msg?.content ?? '',
      tool_calls: toolCalls,
    });

    for (const tc of toolCalls) {
      const { name, args } = readToolCall(tc);
      const kind = toolKind(name);

      if (kind === 'read') {
        const result = await runReadTool(actor, name, args);
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(result),
        });
        continue;
      }

      if (kind === 'write') {
        try {
          const action = await prepareWriteTool(actor, name, args);
          pending.push(action);
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({
              ok: true,
              status: 'awaiting_user_confirmation',
              actionId: action.id,
              tool: action.tool,
              summary: action.label,
              detail: action.detail,
              instruction:
                'This change is queued and shown to the user as a confirmation card. Tell the user what will happen and ask them to confirm. Do not call this tool again for the same request.',
            }),
          });
        } catch (err) {
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({
              ok: false,
              status: 'rejected',
              error: err instanceof Error ? err.message : 'Could not prepare this action',
              instruction: 'Explain the problem to the user and ask how to proceed. Do not retry blindly.',
            }),
          });
        }
        continue;
      }

      // Unknown tool name - tell the model rather than silently dropping it.
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify({ ok: false, error: `No such tool: ${name}` }),
      });
    }
  }

  if (capped) {
    return {
      reply:
        lastText ||
        'That took more steps than I allow in one go. Try asking for one thing at a time.',
      pendingActions: dedupePending(pending),
      steps,
      capped: true,
      usage: { totalTokens },
    };
  }

  return {
    reply: lastText || 'Here is what I found.',
    pendingActions: dedupePending(pending),
    steps,
    capped,
    usage: { totalTokens },
  };
}
