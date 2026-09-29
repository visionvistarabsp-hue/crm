import { describe, it, expect } from 'vitest';
import { buildTimeline, __testables } from '@/lib/services/customerHistory';

const { toNumber, iso, filterPayments } = __testables;

const entry = (over: Partial<Parameters<typeof buildTimeline>[0][number]> = {}) => ({
  id: 'x1',
  kind: 'ACTIVITY' as const,
  title: 'Note',
  detail: null,
  amount: null,
  status: null,
  refId: 'r1',
  actorName: null,
  at: new Date('2026-01-01T00:00:00.000Z'),
  ...over,
});

describe('customerHistory toNumber', () => {
  it('parses numeric strings from Postgres numeric columns', () => {
    expect(toNumber('1234.50')).toBe(1234.5);
    expect(toNumber('0')).toBe(0);
  });

  it('accepts plain numbers', () => {
    expect(toNumber(99)).toBe(99);
    expect(toNumber(0)).toBe(0);
  });

  it('falls back to zero for null, undefined and junk', () => {
    expect(toNumber(null)).toBe(0);
    expect(toNumber(undefined)).toBe(0);
    expect(toNumber('')).toBe(0);
    expect(toNumber('abc')).toBe(0);
    expect(toNumber(Number.NaN)).toBe(0);
    expect(toNumber(Number.POSITIVE_INFINITY)).toBe(0);
    expect(toNumber({})).toBe(0);
  });
});

describe('customerHistory iso', () => {
  it('normalises Date and string inputs to ISO', () => {
    expect(iso(new Date('2026-03-04T05:06:07.000Z'))).toBe('2026-03-04T05:06:07.000Z');
    expect(iso('2026-03-04T05:06:07.000Z')).toBe('2026-03-04T05:06:07.000Z');
  });

  it('returns null for missing or unparseable values', () => {
    expect(iso(null)).toBeNull();
    expect(iso(undefined)).toBeNull();
    expect(iso('not-a-date')).toBeNull();
  });
});

describe('customerHistory filterPayments', () => {
  it('keeps settled and in-flight payments', () => {
    const rows = [{ id: '1', status: 'RECEIVED' }, { id: '2', status: 'PENDING' }];
    expect(filterPayments(rows).map((r) => r.id)).toEqual(['1', '2']);
  });

  it('drops bounced and reversed payments from the money position', () => {
    const rows = [
      { id: '1', status: 'RECEIVED' },
      { id: '2', status: 'BOUNCED' },
      { id: '3', status: 'REVERSED' },
      { id: '4', status: 'RECEIVED' },
    ];
    expect(filterPayments(rows).map((r) => r.id)).toEqual(['1', '4']);
  });

  it('preserves the row type so relation fields survive filtering', () => {
    const rows = [{ id: '1', status: 'RECEIVED', receivedBy: { name: 'Aarti' } }];
    expect(filterPayments(rows)[0].receivedBy?.name).toBe('Aarti');
  });
});

describe('customerHistory buildTimeline', () => {
  it('sorts events newest first', () => {
    const out = buildTimeline([
      entry({ id: 'old', at: new Date('2026-01-01T00:00:00.000Z') }),
      entry({ id: 'new', at: new Date('2026-06-01T00:00:00.000Z') }),
      entry({ id: 'mid', at: new Date('2026-03-01T00:00:00.000Z') }),
    ]);
    expect(out.map((e) => e.id)).toEqual(['new', 'mid', 'old']);
  });

  it('keeps events sharing the same instant in input order', () => {
    const at = new Date('2026-02-02T00:00:00.000Z');
    const out = buildTimeline([entry({ id: 'a', at }), entry({ id: 'b', at })]);
    expect(out.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('drops events with no usable timestamp instead of sorting them as 1970', () => {
    const out = buildTimeline([
      entry({ id: 'undated', at: null }),
      entry({ id: 'dated', at: new Date('2026-01-01T00:00:00.000Z') }),
    ]);
    expect(out.map((e) => e.id)).toEqual(['dated']);
  });

  it('normalises every timestamp to an ISO string', () => {
    const out = buildTimeline([entry({ at: '2026-04-01T10:00:00.000Z' })]);
    expect(out[0].at).toBe('2026-04-01T10:00:00.000Z');
  });

  it('carries kind, amount and status through unchanged', () => {
    const out = buildTimeline([
      entry({ kind: 'PAYMENT', amount: 45000, status: 'RECEIVED', actorName: 'Aarti' }),
    ]);
    expect(out[0]).toMatchObject({ kind: 'PAYMENT', amount: 45000, status: 'RECEIVED', actorName: 'Aarti' });
  });

  it('returns an empty list for no events', () => {
    expect(buildTimeline([])).toEqual([]);
  });
});
