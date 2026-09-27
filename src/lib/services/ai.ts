import { writeAudit } from '@/lib/audit';
import type { Actor } from '@/lib/api';
import { db } from '@/lib/db';
import { leads } from '@/lib/db/schema';
import { eq, sql } from 'drizzle-orm';
import { clampScore, coerceBrief, extractJson, type LeadAiBrief } from '@/lib/services/aiBrief';

export type { LeadAiBrief };

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

/** Groq is optional: the app must be fully usable with no key configured. */
const DEFAULT_MODEL = 'openai/gpt-oss-120b';
const TIMEOUT_MS = 30_000;
/** Reasoning models bill their hidden thinking against this budget, so leave headroom for the brief itself. */
const MAX_TOKENS = 1200;

export function aiConfig(): { key: string; model: string } | null {
  const key = process.env.GROQ_API_KEY?.trim();
  if (!key) return null;
  return { key, model: process.env.GROQ_MODEL?.trim() || DEFAULT_MODEL };
}

export function isAiConfigured(): boolean {
  return aiConfig() !== null;
}

type LeadFacts = {
  name: string;
  status: string;
  source: string | null;
  campaign: string | null;
  budget: string | null;
  notes: string | null;
  preferredLocation: string | null;
  propertyType: string | null;
  requirement: string | null;
  priority: string | null;
  phone: string | null;
  owner: string | null;
  createdAt: Date | null;
};

/** The owner's display name, resolved inline so the lead is read in one query. */
function ownerName(ownerId: unknown) {
  return sql<string | null>`(select u.name from users u where u.id = ${ownerId as string})`;
}

async function leadFacts(leadId: string): Promise<LeadFacts | null> {
  const rows = await db
    .select({
      name: leads.name,
      status: leads.status,
      source: leads.source,
      campaign: leads.campaign,
      budget: leads.budget,
      notes: leads.notes,
      preferredLocation: leads.preferredLocation,
      propertyType: leads.propertyType,
      requirement: leads.requirement,
      priority: leads.priority,
      phone: leads.phone,
      createdAt: leads.createdAt,
      owner: ownerName(leads.ownerId),
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  return rows[0] ?? null;
}

/** Ask Groq for a JSON brief. Throws on provider failure; never returns malformed JSON. */
async function askGroq(system: string, user: string): Promise<Record<string, unknown>> {
  const cfg = aiConfig();
  if (!cfg) throw new Error('GROQ_NOT_CONFIGURED');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.3,
        max_tokens: MAX_TOKENS,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Groq ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ finish_reason?: string | null; message?: { content?: string } }>;
    };
    const choice = data.choices?.[0];
    const raw = choice?.message?.content;
    if (choice?.finish_reason === 'length') {
      throw new Error('Groq stopped at the token limit before finishing the brief');
    }
    if (!raw) throw new Error('Groq returned an empty completion');
    return extractJson(raw);
  } finally {
    clearTimeout(timer);
  }
}

const SYSTEM = `You are a real-estate sales assistant. You assess inbound leads for an Indian real-estate CRM.
Reply with ONLY a JSON object, no prose and no markdown fences, with these keys:
  "summary": string, 2-3 sentences describing the buyer and what they want.
  "score": integer 0-100, how likely this lead is to convert soon.
  "factors": array of 3-5 short strings, each a concrete reason behind the score.
Be specific and use only the facts given. Never invent budget, timeline or intent. If a fact is missing, say so in the factor.`;

function factsPrompt(f: LeadFacts): string {
  const rows: Array<[string, string | null]> = [
    ['Name', f.name],
    ['Phone', f.phone],
    ['Pipeline status', f.status],
    ['Priority', f.priority],
    ['Lead source', f.source],
    ['Campaign', f.campaign],
    ['Budget', f.budget],
    ['Preferred location', f.preferredLocation],
    ['Property type', f.propertyType],
    ['Requirement', f.requirement],
    ['Assigned to', f.owner],
    ['Created at', f.createdAt ? f.createdAt.toISOString() : null],
    ['Notes', f.notes],
  ];
  return rows
    .filter(([, v]) => v !== null && v !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

/** Read whatever AI brief is already stored on a lead, if any. */
export async function getLeadBrief(leadId: string): Promise<LeadAiBrief | null> {
  const rows = await db
    .select({ metadata: leads.metadata })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  const meta = rows[0]?.metadata as Record<string, unknown> | null | undefined;
  if (!meta) return null;

  // Legacy seed rows stored the whole AI_SUMMARY_SEED list in `aiSummary`
  // instead of one picked string. Normalise anything unexpected to a usable
  // string so the panel never renders a blank or object-shaped summary.
  const raw = meta.aiSummary;
  const summary = typeof raw === 'string' ? raw.trim() : '';

  // A brief with no readable summary is not worth showing: the panel would
  // otherwise render a score next to an empty box.
  if (!summary) return null;

  return {
    summary,
    score: typeof meta.aiScore === 'number' ? clampScore(meta.aiScore) : 0,
    factors: Array.isArray(meta.aiFactors)
      ? meta.aiFactors.filter((f): f is string => typeof f === 'string' && f.trim() !== '').slice(0, 5)
      : [],
    source: meta.aiSummarySource === 'groq' ? 'groq' : 'seed',
    model: typeof meta.aiModel === 'string' ? meta.aiModel : 'seed',
    generatedAt: typeof meta.aiGeneratedAt === 'string' ? meta.aiGeneratedAt : '',
  };
}

/**
 * Generate a fresh brief for a lead and persist it on `leads.metadata`.
 * The write is additive: existing metadata keys are preserved.
 */
export async function generateLeadBrief(actor: Actor, leadId: string): Promise<LeadAiBrief> {
  const cfg = aiConfig();
  if (!cfg) throw new Error('GROQ_NOT_CONFIGURED');

  const facts = await leadFacts(leadId);
  if (!facts) throw new Error('Lead not found');

  const brief = coerceBrief(await askGroq(SYSTEM, factsPrompt(facts)), cfg.model);

  const current = await db
    .select({ metadata: leads.metadata })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  const prev = (current[0]?.metadata ?? {}) as Record<string, unknown>;

  await db
    .update(leads)
    .set({
      metadata: {
        ...prev,
        aiSummary: brief.summary,
        aiSummarySource: 'groq',
        aiScore: brief.score,
        aiFactors: brief.factors,
        aiModel: brief.model,
        aiGeneratedAt: brief.generatedAt,
      },
    })
    .where(eq(leads.id, leadId));

  await writeAudit({
    actor,
    action: 'AI_GENERATE',
    entity: 'lead',
    entityId: leadId,
    newValue: { score: brief.score, model: brief.model },
  });

  return brief;
}
