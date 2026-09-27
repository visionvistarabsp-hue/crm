/**
 * Target achievement and pipeline forecasting.
 *
 * The arithmetic here is deliberately separated from the database access so it
 * can be unit tested without a connection, and so the weighting scheme is a
 * single auditable table rather than a number scattered through a query.
 */
import { OPEN_STATUSES, PIPELINE_POSITION, type LeadStatus } from '@/lib/constants';

/** `YYYY-MM` for a Date, matching analytics.monthKey. */
export const monthKey = (d: Date): string =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

export function isPeriod(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}

/** Half-open UTC window for a `YYYY-MM` period. */
export function periodRange(period: string): { from: Date; to: Date } {
  if (!isPeriod(period)) throw new Error(`Invalid period: ${period}`);
  const [y, m] = period.split('-').map(Number);
  return { from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 1)) };
}

/**
 * Probability that an open lead at a given stage eventually closes.
 *
 * Calibrated against Indian residential pre-sales: a fresh enquiry is worth
 * very little, a negotiation-stage lead is worth most of the budget, and a lead
 * already collecting documents is nearly certain. Kept as an explicit table so
 * a sales director can argue with the numbers instead of guessing at them.
 */
export const STAGE_WEIGHT: Record<LeadStatus, number> = {
  NEW: 0.02,
  CONTACT_PENDING: 0.05,
  CONTACTED: 0.1,
  QUALIFIED: 0.2,
  FOLLOW_UP: 0.2,
  MEETING: 0.35,
  SITE_VISIT_1: 0.4,
  SITE_VISIT_2: 0.5,
  SITE_VISIT_3: 0.6,
  NEGOTIATION: 0.7,
  BOOKING: 0.9,
  DOCUMENT_COLLECTION: 0.95,
  NOT_INTERESTED: 0,
  CALL_BACK_LATER: 0,
  WRONG_NUMBER: 0,
  DUPLICATE: 0,
  DEAL_COMPLETED: 0,
  LOST: 0,
  CANCELLED: 0,
};

/** Days of silence after which a lead's weight is discounted. */
export const STALE_AFTER_DAYS = 14;
/** A stale lead is worth roughly half of a fresh one. */
export const STALE_FACTOR = 0.5;

export const num = (v: number | string | null | undefined): number => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return v === null || v === undefined || isNaN(Number(n)) ? 0 : Number(n);
};

export interface ForecastLead {
  id: string;
  status: string;
  budget: number | string | null;
  /** Last touch of any kind; falls back to creation. */
  lastActivityAt: Date | null;
  createdAt: Date;
  ownerName?: string | null;
}

export interface WeightedLead extends ForecastLead {
  /** 0 when the status is closed out. */
  weight: number;
  expectedValue: number;
  stale: boolean;
  daysSinceTouch: number;
}

const DAY_MS = 86_400_000;

export function daysSince(date: Date | null | undefined, now: Date): number {
  if (!date) return 0;
  return Math.max(0, Math.floor((now.getTime() - new Date(date).getTime()) / DAY_MS));
}

/**
 * Weight a single lead, and say how much of that weight is guesswork.
 *
 * A lead that has not been touched in a fortnight is not the same lead as one
 * from this morning, so silence discounts it. Without this the forecast
 * rewards salespeople for hoarding stale enquiries.
 */
export function weighLead(lead: ForecastLead, now: Date): WeightedLead {
  const status = lead.status as LeadStatus;
  const base = OPEN_STATUSES.includes(status) ? (STAGE_WEIGHT[status] ?? 0) : 0;
  const last = lead.lastActivityAt ?? lead.createdAt;
  const days = daysSince(last, now);
  const stale = base > 0 && days >= STALE_AFTER_DAYS;
  const weight = stale ? base * STALE_FACTOR : base;
  const budget = num(lead.budget);
  return { ...lead, weight, expectedValue: round2(budget * weight), stale, daysSinceTouch: days };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface ForecastResult {
  /** Unweighted sum of every open lead's budget. */
  pipelineValue: number;
  /** Probability-weighted sum - the number to plan against. */
  expectedValue: number;
  weightedLeads: WeightedLead[];
  openCount: number;
  staleCount: number;
  byStage: Array<{ status: string; count: number; budget: number; expected: number }>;
}

export function computeForecast(leads: ForecastLead[], now: Date = new Date()): ForecastResult {
  const weighted = leads
    .map((l) => weighLead(l, now))
    .filter((l) => PIPELINE_POSITION[l.status as LeadStatus] >= 0);

  const open = weighted.filter((l) => l.weight > 0);
  const byStageMap = new Map<string, { count: number; budget: number; expected: number }>();
  for (const l of open) {
    const cur = byStageMap.get(l.status) ?? { count: 0, budget: 0, expected: 0 };
    cur.count += 1;
    cur.budget = round2(cur.budget + num(l.budget));
    cur.expected = round2(cur.expected + l.expectedValue);
    byStageMap.set(l.status, cur);
  }

  return {
    pipelineValue: round2(open.reduce((s, l) => s + num(l.budget), 0)),
    expectedValue: round2(open.reduce((s, l) => s + l.expectedValue, 0)),
    weightedLeads: open.sort((a, b) => b.expectedValue - a.expectedValue),
    openCount: open.length,
    staleCount: open.filter((l) => l.stale).length,
    byStage: [...byStageMap.entries()]
      .map(([status, v]) => ({ status, ...v }))
      .sort((a, b) => PIPELINE_POSITION[a.status as LeadStatus] - PIPELINE_POSITION[b.status as LeadStatus]),
  };
}

export interface Achievement {
  target: number | null;
  actual: number;
  /** null when no target is set, so the UI can say "not set" not "0%". */
  attainment: number | null;
  gap: number;
  /** Actual as a share of target, capped for display at 100. */
  pct: number;
}

/** Targets arrive as `numeric` strings from Postgres, so widen the input. */
export function achievement(target: number | string | null, actual: number | string): Achievement {
  // Only a genuinely absent target means "not set". Numeric columns come back as
  // strings, so the value has to go through num() before the null test - testing
  // the raw string with isFinite would silently discard every real target.
  const t = target === null || target === undefined ? null : num(target);
  const a = num(actual);
  if (t === null || t === 0) {
    return { target: t, actual: round2(a), attainment: null, gap: 0, pct: 0 };
  }
  const ratio = a / t;
  return {
    target: round2(t),
    actual: round2(a),
    attainment: round2(ratio * 100),
    // Clamped like pct: exceeding the target is not a negative shortfall.
    gap: round2(Math.max(0, t - a)),
    pct: Math.min(100, Math.max(0, ratio * 100)),
  };
}

/**
 * What a salesperson should focus on next, derived rather than hardcoded.
 * Surfaces the deals with the most value that are going cold.
 */
export interface FocusLead {
  id: string;
  name: string;
  status: string;
  expectedValue: number;
  daysSinceTouch: number;
  stale: boolean;
}

export function focusQueue(leads: WeightedLead[], limit = 10): FocusLead[] {
  return leads
    .filter((l) => l.expectedValue > 0)
    .map((l) => ({
      id: l.id,
      name: l.ownerName ?? '',
      status: l.status,
      expectedValue: l.expectedValue,
      daysSinceTouch: l.daysSinceTouch,
      stale: l.stale,
    }))
    .sort((a, b) => {
      // Cold deals first: a stale lead needs attention before a fresh one,
      // and among equals take the bigger prize.
      if (a.stale !== b.stale) return a.stale ? -1 : 1;
      return b.expectedValue - a.expectedValue;
    })
    .slice(0, limit);
}
