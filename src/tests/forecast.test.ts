import { describe, it, expect } from 'vitest';
import {
  achievement,
  computeForecast,
  daysSince,
  focusQueue,
  isPeriod,
  periodRange,
  round2,
  STAGE_WEIGHT,
  STALE_AFTER_DAYS,
  STALE_FACTOR,
  weighLead,
  type ForecastLead,
} from '../lib/services/forecast';

const NOW = new Date('2026-06-15T00:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const lead = (over: Partial<ForecastLead> = {}): ForecastLead => ({
  id: 'l1',
  status: 'NEW',
  budget: 5_000_000,
  lastActivityAt: NOW,
  createdAt: NOW,
  ownerName: 'Test Owner',
  ...over,
});

describe('period handling', () => {
  it('accepts YYYY-MM and rejects other shapes', () => {
    expect(isPeriod('2026-06')).toBe(true);
    expect(isPeriod('2026-13')).toBe(false);
    expect(isPeriod('2026-00')).toBe(false);
    expect(isPeriod('2026-6')).toBe(false);
    expect(isPeriod('june')).toBe(false);
    expect(isPeriod(null)).toBe(false);
  });

  it('builds a half-open UTC month range', () => {
    const { from, to } = periodRange('2026-02');
    expect(from.toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });
});

describe('daysSince', () => {
  it('is 0 for a touch today and grows with age', () => {
    expect(daysSince(NOW, NOW)).toBe(0);
    expect(daysSince(daysAgo(10), NOW)).toBe(10);
  });

  it('never returns a negative age for a future-dated touch', () => {
    expect(daysSince(new Date(NOW.getTime() + 5 * 86_400_000), NOW)).toBe(0);
  });

  it('reports no age for a null touch, since weighLead falls back to createdAt', () => {
    expect(daysSince(null, NOW)).toBe(0);
  });
});

describe('weighLead', () => {
  it('applies the stage weight to the budget', () => {
    const w = weighLead(lead({ status: 'NEW' }), NOW);
    expect(w.weight).toBe(STAGE_WEIGHT.NEW);
    expect(w.expectedValue).toBe(round2(5_000_000 * STAGE_WEIGHT.NEW));
    expect(w.stale).toBe(false);
  });

  it('halves a lead that has gone quiet past the stale window', () => {
    const w = weighLead(lead({ lastActivityAt: daysAgo(STALE_AFTER_DAYS + 10) }), NOW);
    expect(w.stale).toBe(true);
    expect(w.weight).toBeCloseTo(STAGE_WEIGHT.NEW * STALE_FACTOR, 6);
    expect(w.expectedValue).toBe(round2(5_000_000 * STAGE_WEIGHT.NEW * STALE_FACTOR));
  });

  it('tips into stale on the stale window itself, not the day after', () => {
    expect(weighLead(lead({ lastActivityAt: daysAgo(STALE_AFTER_DAYS - 1) }), NOW).stale).toBe(false);
    expect(weighLead(lead({ lastActivityAt: daysAgo(STALE_AFTER_DAYS) }), NOW).stale).toBe(true);
  });

  it('falls back to createdAt when a lead has never been touched', () => {
    const w = weighLead(lead({ lastActivityAt: null, createdAt: daysAgo(30) }), NOW);
    expect(w.stale).toBe(true);
    expect(w.daysSinceTouch).toBe(30);
  });

  it('never weights a closed-out lead', () => {
    for (const status of ['LOST', 'DEAL_COMPLETED', 'NOT_INTERESTED', 'WRONG_NUMBER', 'DUPLICATE']) {
      expect(weighLead(lead({ status }), NOW).expectedValue).toBe(0);
    }
  });

  it('treats a lead with no budget as worth nothing', () => {
    expect(weighLead(lead({ budget: null }), NOW).expectedValue).toBe(0);
  });

  it('reads a numeric budget stored as a string', () => {
    expect(weighLead(lead({ budget: '5000000' }), NOW).expectedValue).toBe(
      round2(5_000_000 * STAGE_WEIGHT.NEW),
    );
  });
});

describe('computeForecast', () => {
  it('separates pipeline value from weighted expected value', () => {
    const res = computeForecast(
      [lead({ id: 'a', status: 'NEW' }), lead({ id: 'b', status: 'NEGOTIATION' })],
      NOW,
    );
    expect(res.pipelineValue).toBe(10_000_000);
    expect(res.expectedValue).toBe(
      round2(5_000_000 * STAGE_WEIGHT.NEW + 5_000_000 * STAGE_WEIGHT.NEGOTIATION),
    );
    expect(res.openCount).toBe(2);
  });

  it('excludes closed-out leads from the pipeline entirely', () => {
    const res = computeForecast([lead({ status: 'LOST' })], NOW);
    expect(res.pipelineValue).toBe(0);
    expect(res.expectedValue).toBe(0);
    expect(res.openCount).toBe(0);
  });

  it('counts stale leads without dropping them', () => {
    const res = computeForecast([lead({ lastActivityAt: daysAgo(40) })], NOW);
    expect(res.openCount).toBe(1);
    expect(res.staleCount).toBe(1);
  });

  it('groups by stage and orders stages along the pipeline', () => {
    const res = computeForecast(
      [
        lead({ id: 'a', status: 'NEGOTIATION' }),
        lead({ id: 'b', status: 'NEW' }),
        lead({ id: 'c', status: 'NEGOTIATION' }),
      ],
      NOW,
    );
    const stages = res.byStage.map((s) => s.status);
    expect(stages.indexOf('NEW')).toBeLessThan(stages.indexOf('NEGOTIATION'));
    const neg = res.byStage.find((s) => s.status === 'NEGOTIATION');
    expect(neg?.count).toBe(2);
    expect(neg?.budget).toBe(10_000_000);
  });

  it('handles an empty pipeline', () => {
    const res = computeForecast([], NOW);
    expect(res.pipelineValue).toBe(0);
    expect(res.expectedValue).toBe(0);
    expect(res.byStage).toEqual([]);
    expect(res.openCount).toBe(0);
  });
});

describe('achievement', () => {
  it('reports no attainment when no target is set', () => {
    const a = achievement(null, 1_000_000);
    expect(a.target).toBeNull();
    expect(a.attainment).toBeNull();
    expect(a.pct).toBe(0);
    expect(a.gap).toBe(0);
  });

  it('computes attainment and the remaining gap', () => {
    const a = achievement(4_000_000, 1_000_000);
    expect(a.attainment).toBe(25);
    expect(a.pct).toBe(25);
    expect(a.gap).toBe(3_000_000);
  });

  it('clamps pct at 100 but lets actual exceed the target', () => {
    const a = achievement(1_000_000, 1_500_000);
    expect(a.attainment).toBe(150);
    expect(a.pct).toBe(100);
    expect(a.gap).toBe(0);
  });

  it('treats a zero target as not set instead of dividing by zero', () => {
    const a = achievement(0, 500_000);
    expect(a.attainment).toBeNull();
    expect(Number.isFinite(a.pct)).toBe(true);
  });

  it('accepts numeric strings, which is how Postgres returns the column', () => {
    const a = achievement('2000000', '500000');
    expect(a.target).toBe(2_000_000);
    expect(a.attainment).toBe(25);
  });

  it('treats an unparseable target as not set rather than NaN', () => {
    const a = achievement('not-a-number', 500_000);
    expect(a.target).toBe(0);
    expect(a.attainment).toBeNull();
  });
});

describe('focusQueue', () => {
  it('puts the bigger prize first among equally fresh leads', () => {
    const queue = focusQueue(
      [
        weighLead(lead({ id: 'small', status: 'NEW' }), NOW),
        weighLead(lead({ id: 'big', status: 'NEGOTIATION', budget: 9_000_000 }), NOW),
      ],
      10,
    );
    expect(queue[0].id).toBe('big');
  });

  it('chases a cold lead ahead of a bigger fresh one', () => {
    const queue = focusQueue(
      [
        weighLead(lead({ id: 'fresh-big', status: 'NEGOTIATION', budget: 9_000_000 }), NOW),
        weighLead(lead({ id: 'cold-small', status: 'NEW', lastActivityAt: daysAgo(30) }), NOW),
      ],
      10,
    );
    expect(queue[0].id).toBe('cold-small');
    expect(queue[0].stale).toBe(true);
  });

  it('respects the limit', () => {
    const many = Array.from({ length: 20 }, (_, i) => weighLead(lead({ id: `l${i}` }), NOW));
    expect(focusQueue(many, 3)).toHaveLength(3);
  });

  it('skips leads worth nothing', () => {
    const queue = focusQueue([weighLead(lead({ status: 'LOST' }), NOW)], 5);
    expect(queue).toHaveLength(0);
  });

  it('carries the owner through as the display name', () => {
    const queue = focusQueue([weighLead(lead({ ownerName: 'Asha Rao' }), NOW)], 1);
    expect(queue[0].name).toBe('Asha Rao');
  });
});
