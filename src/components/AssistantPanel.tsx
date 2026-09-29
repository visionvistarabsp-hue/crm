'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  Check,
  Loader2,
  MessageSquare,
  Send,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { cn } from '@/components/ui';
import { fetcher } from '@/lib/fetcher';
import type { PendingAction } from '@/lib/services/ai/tools';

/** Mirrors StoredMessage, but dates arrive as ISO strings over the wire. */
type WireMessage = {
  id: string;
  role: string;
  content: string;
  pendingActions: PendingAction[];
};

type Outcome = {
  id: string;
  tool: string;
  label: string;
  ok: boolean;
  summary?: string;
  error?: string;
};

type GetResponse = {
  configured: boolean;
  conversationId: string | null;
  messages: WireMessage[];
};

type PostResponse = { conversationId: string; reply: WireMessage };

/** Must stay in step with the zod cap in /api/assistant. */
const MAX_LEN = 4000;

const SUGGESTIONS = [
  'What follow-ups are due today?',
  'Book a site visit for tomorrow',
  'Which leads have not been contacted this week?',
];

// ---------------------------------------------------------------------------
// Confirm card
// ---------------------------------------------------------------------------

function ConfirmCard({
  action,
  outcome,
  busy,
  onConfirm,
  onDiscard,
}: {
  action: PendingAction;
  outcome: Outcome | null;
  busy: boolean;
  onConfirm: () => void;
  onDiscard: () => void;
}) {
  // Once resolved the card is a receipt, not a prompt.
  if (outcome) {
    return (
      <div
        className={cn(
          'mt-2 rounded-2xl px-4 py-3 shadow-clay-inset-sm',
          outcome.ok ? 'bg-primary-50 text-primary-800' : 'bg-rose-50 text-rose-700',
        )}
      >
        <p className="flex items-center gap-2 text-sm font-bold">
          {outcome.ok ? <Check size={15} /> : <AlertTriangle size={15} />}
          {outcome.label}
        </p>
        <p className="mt-1 text-xs font-medium opacity-90">
          {outcome.ok ? outcome.summary : outcome.error}
        </p>
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-2xl bg-surface p-4 shadow-clay-sm">
      <p className="flex items-center gap-2 text-sm font-bold text-ink">
        <Sparkles size={15} className="shrink-0 text-primary-600" />
        {action.label}
      </p>

      <ul className="mt-2 space-y-1">
        {action.detail.map((line, i) => (
          <li key={i} className="text-xs font-medium text-ink-muted">
            {line}
          </li>
        ))}
      </ul>

      {action.warning && (
        <p className="mt-2 flex items-start gap-2 rounded-xl bg-accent-100 px-3 py-2 text-[11px] font-semibold text-ink">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          {action.warning}
        </p>
      )}

      <div className="mt-3 flex gap-2">
        <button className="btn-primary flex-1 !py-2 text-xs" onClick={onConfirm} disabled={busy}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
          Confirm
        </button>
        <button
          className="btn-secondary !px-3 !py-2 text-xs"
          onClick={onDiscard}
          disabled={busy}
          aria-label="Discard this action"
        >
          <Trash2 size={14} />
        </button>
      </div>
      <p className="mt-2 text-[10px] font-medium text-ink-faint">Nothing is saved until you confirm.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export default function AssistantPanel() {
  const [open, setOpen] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<WireMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Action ids already applied or discarded, so cards stop re-offering. */
  const [resolved, setResolved] = useState<Record<string, Outcome | 'discarded'>>({});
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const pendingCount = messages
    .flatMap((m) => m.pendingActions ?? [])
    .filter((a) => !resolved[a.id]).length;

  // Load the thread when the drawer opens, so a reload keeps the history.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetcher<GetResponse>('/api/assistant')
      .then((d) => {
        if (cancelled) return;
        setConfigured(d.configured);
        setConversationId(d.conversationId);
        setMessages(d.messages ?? []);
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || sending) return;
      setSending(true);
      setError(null);
      setInput('');

      // Optimistic user bubble, replaced by the server copy on success.
      const optimistic: WireMessage = {
        id: `local-${Date.now()}`,
        role: 'user',
        content: trimmed,
        pendingActions: [],
      };
      setMessages((prev) => [...prev, optimistic]);

      try {
        const res = await fetcher<PostResponse>('/api/assistant', {
          method: 'POST',
          body: JSON.stringify({ message: trimmed, conversationId }),
        });
        setConversationId(res.conversationId);
        setMessages((prev) => [
          ...prev.filter((m) => m.id !== optimistic.id),
          res.reply,
        ]);
      } catch (e) {
        setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
        setInput(trimmed);
        setError(e instanceof Error ? e.message : 'Could not reach the assistant');
      } finally {
        setSending(false);
      }
    },
    [conversationId, sending],
  );

  /** Apply one card. The server re-checks permissions before it writes. */
  const confirmAction = useCallback(
    async (action: PendingAction) => {
      if (!conversationId || busyAction) return;
      setBusyAction(action.id);
      setError(null);
      try {
        const res = await fetcher<{ outcomes: Outcome[] }>('/api/assistant/confirm', {
          method: 'POST',
          body: JSON.stringify({ conversationId, actionIds: [action.id] }),
        });
        setResolved((prev) => ({ ...prev, [action.id]: res.outcomes[0] }));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not apply that change');
      } finally {
        setBusyAction(null);
      }
    },
    [conversationId, busyAction],
  );

  const discardAction = useCallback(
    async (action: PendingAction) => {
      if (!conversationId || busyAction) return;
      setBusyAction(action.id);
      setError(null);
      setResolved((prev) => ({ ...prev, [action.id]: 'discarded' as const }));
      try {
        await fetcher<{ ok: boolean }>('/api/assistant/confirm', {
          method: 'DELETE',
          body: JSON.stringify({ conversationId }),
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not discard');
      } finally {
        setBusyAction(null);
      }
    },
    [conversationId, busyAction],
  );

  const newThread = useCallback(() => {
    setMessages([]);
    setResolved({});
    setConversationId(null);
    setError(null);
    inputRef.current?.focus();
  }, []);

  const unconfigured = configured === false;

  return (
    <>
      {/* Floating bubble */}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? 'Close assistant' : 'Open assistant'}
        aria-expanded={open}
        className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-500 text-white shadow-pop transition-transform hover:scale-105 active:scale-95"
      >
        {open ? <X size={24} /> : <MessageSquare size={24} />}
        {!open && pendingCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-6 min-w-6 items-center justify-center rounded-full bg-rose-500 px-1.5 text-[11px] font-bold text-white shadow-clay-xs">
            {pendingCount}
          </span>
        )}
      </button>

      {/* Drawer */}
      {open && (
        <div className="fixed bottom-6 right-6 z-50 flex h-[min(80vh,640px)] w-[min(92vw,400px)] flex-col overflow-hidden rounded-3xl bg-surface shadow-pop animate-pop-in">
          <div className="flex items-center gap-2.5 border-b border-clay-dark/40 px-4 py-3.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary-500 text-white shadow-clay-sm">
              <Bot size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold text-ink">Assistant</p>
              <p className="truncate text-[11px] font-medium text-ink-faint">
                {unconfigured ? 'Not configured' : 'Reads your records · asks before writing'}
              </p>
            </div>
            <button
              onClick={newThread}
              className="chip-clay !rounded-lg !p-1.5"
              aria-label="Start a new conversation"
              title="New conversation"
            >
              <Sparkles size={15} />
            </button>
            <button
              onClick={() => setOpen(false)}
              className="chip-clay !rounded-lg !p-1.5"
              aria-label="Minimize assistant"
              title="Minimize"
            >
              <X size={15} />
            </button>
          </div>

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
            {loading && (
              <p className="flex items-center justify-center gap-2 py-6 text-xs font-semibold text-ink-faint">
                <Loader2 size={14} className="animate-spin" /> Loading…
              </p>
            )}

            {!loading && unconfigured && (
              <div className="rounded-2xl bg-accent-100 px-4 py-3 text-xs font-semibold text-ink">
                The assistant is switched off. Ask an admin to set GROQ_API_KEY on the server.
              </div>
            )}

            {!loading && !unconfigured && messages.length === 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-ink-muted">Try asking:</p>
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    className="block w-full rounded-xl bg-clay-deep px-3.5 py-2.5 text-left text-xs font-semibold text-ink shadow-clay-inset-sm transition hover:text-ink"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}

            {messages.map((m) => {
              const cards = (m.pendingActions ?? []).filter((a) => a.id);
              const isUser = m.role === 'user';
              return (
                <div key={m.id} className={cn('flex flex-col', isUser ? 'items-end' : 'items-start')}>
                  <div
                    className={cn(
                      'max-w-[88%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm font-medium shadow-clay-sm',
                      isUser
                        ? 'bg-primary-500 text-white'
                        : 'bg-clay-deep text-ink',
                    )}
                  >
                    {m.content}
                  </div>

                  {!isUser &&
                    cards.map((a) => {
                      const r = resolved[a.id];
                      return (
                        <div key={a.id} className="w-full max-w-[88%]">
                          <ConfirmCard
                            action={a}
                            outcome={r === 'discarded' ? null : (r ?? null)}
                            busy={busyAction === a.id}
                            onConfirm={() => confirmAction(a)}
                            onDiscard={() => discardAction(a)}
                          />
                          {r === 'discarded' && (
                            <p className="mt-1 px-1 text-[10px] font-semibold text-ink-faint">
                              Discarded — nothing was saved.
                            </p>
                          )}
                        </div>
                      );
                    })}
                </div>
              );
            })}

            {sending && (
              <div className="flex items-start">
                <div className="flex items-center gap-1.5 rounded-2xl bg-clay-deep px-4 py-3 text-ink-faint shadow-clay-sm">
                  <Loader2 size={14} className="animate-spin" />
                  <span className="text-xs font-semibold">Thinking…</span>
                </div>
              </div>
            )}
          </div>

          {error && (
            <p className="mx-4 mb-2 rounded-xl bg-rose-50 px-3 py-2 text-[11px] font-semibold text-rose-700">
              {error}
            </p>
          )}

          <form
            className="flex items-end gap-2 border-t border-clay-dark/40 px-3 py-3"
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
          >
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value.slice(0, MAX_LEN))}
              onKeyDown={(e) => {
                // Enter sends; Shift+Enter is a newline.
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              rows={1}
              disabled={sending || unconfigured}
              placeholder={unconfigured ? 'Assistant is off' : 'Ask about leads, follow-ups, meetings…'}
              className="input max-h-28 min-h-[42px] flex-1 resize-none !py-2.5 text-sm"
            />
            <button
              type="submit"
              disabled={sending || !input.trim() || unconfigured}
              aria-label="Send message"
              className="btn-primary !rounded-xl !p-2.5"
            >
              {sending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
            </button>
          </form>
        </div>
      )}
    </>
  );
}
