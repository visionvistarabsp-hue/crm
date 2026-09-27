/**
 * Pure parsing and validation for the Groq lead brief. Kept free of database and
 * audit imports so the response contract can be exercised in isolation - reasoning
 * models are the reason this is defensive: they truncate, and they sometimes fence
 * or narrate around the JSON they were asked for.
 */

/** What the lead detail panel stores on `leads.metadata`. */
export interface LeadAiBrief {
  summary: string;
  score: number;
  factors: string[];
  source: 'groq' | 'seed';
  model: string;
  generatedAt: string;
}

/** Reads the outermost JSON object, tolerating fences or a leading sentence. */
export function extractJson(raw: string): Record<string, unknown> {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  const candidate = start !== -1 && end > start ? raw.slice(start, end + 1) : raw;
  return JSON.parse(candidate) as Record<string, unknown>;
}

export function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Throws when there is no usable summary; otherwise returns a safe, clamped brief. */
export function coerceBrief(parsed: Record<string, unknown>, model: string): LeadAiBrief {
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  if (!summary) throw new Error('Groq response had no summary');

  const rawScore = Number(parsed.score);
  const score = Number.isFinite(rawScore) ? clampScore(rawScore) : 0;

  const factors = Array.isArray(parsed.factors)
    ? parsed.factors
        .map((f) => (typeof f === 'string' ? f.trim() : ''))
        .filter(Boolean)
        .slice(0, 5)
    : [];

  return { summary, score, factors, source: 'groq', model, generatedAt: new Date().toISOString() };
}
