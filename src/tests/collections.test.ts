import { describe, it, expect } from 'vitest';
import {
  ageingBuckets,
  agingKey,
  amountInWords,
  deriveStatus,
  isSettled,
} from '../lib/services/collections';
import { AGING_BUCKETS } from '../lib/constants';

describe('isSettled', () => {
  it('is settled once paid meets the amount', () => {
    expect(isSettled(100_000, 100_000)).toBe(true);
    expect(isSettled(100_000, 100_001)).toBe(true);
  });

  it('is not settled a rupee short', () => {
    expect(isSettled(100_000, 99_999)).toBe(false);
  });

  it('absorbs sub-paise float drift so a settled row does not look partial', () => {
    // Three instalments of 1/3 of a rupee add up to 0.9999999 in float maths.
    expect(isSettled(1, 0.1 + 0.2 + 0.7)).toBe(true);
    expect(isSettled(33.33, 11.11 * 3)).toBe(true);
  });
});

describe('deriveStatus', () => {
  it('is PENDING with nothing paid', () => {
    expect(deriveStatus(0, 100_000, 'PENDING')).toBe('PENDING');
  });

  it('is PARTIAL with some but not all paid', () => {
    expect(deriveStatus(40_000, 100_000, 'PENDING')).toBe('PARTIAL');
  });

  it('is PAID once fully settled', () => {
    expect(deriveStatus(100_000, 100_000, 'PARTIAL')).toBe('PAID');
    expect(deriveStatus(100_000, 100_000, 'PENDING')).toBe('PAID');
  });

  it('never un-waives a waived milestone, even when it is fully paid', () => {
    expect(deriveStatus(100_000, 100_000, 'WAIVED')).toBe('WAIVED');
    expect(deriveStatus(0, 100_000, 'WAIVED')).toBe('WAIVED');
  });
});

describe('agingKey', () => {
  it('treats anything not yet late as current', () => {
    expect(agingKey(0)).toBe('current');
    expect(agingKey(-5)).toBe('current');
  });

  it('places the boundaries in the lower bucket', () => {
    expect(agingKey(1)).toBe('d1_30');
    expect(agingKey(30)).toBe('d1_30');
    expect(agingKey(31)).toBe('d31_60');
    expect(agingKey(60)).toBe('d31_60');
    expect(agingKey(61)).toBe('d61_90');
    expect(agingKey(90)).toBe('d61_90');
    expect(agingKey(91)).toBe('d90plus');
  });

  it('only ever returns a bucket the UI knows about', () => {
    for (const d of [-10, 0, 1, 45, 75, 200, 5000]) {
      expect(AGING_BUCKETS.map((b) => b.key)).toContain(agingKey(d));
    }
  });
});

describe('ageingBuckets', () => {
  it('sums outstanding by bucket and counts the rows in each', () => {
    const result = ageingBuckets([
      { daysOverdue: 5, outstanding: 100_000 },
      { daysOverdue: 45, outstanding: 250_000 },
      { daysOverdue: 200, outstanding: 50_000 },
    ]);
    const byKey = Object.fromEntries(result.map((b) => [b.key, b]));
    expect(byKey.d1_30.amount).toBe(100_000);
    expect(byKey.d1_30.count).toBe(1);
    expect(byKey.d31_60.amount).toBe(250_000);
    expect(byKey.d90plus.amount).toBe(50_000);
  });

  it('adds up several rows landing in the same band', () => {
    const [bucket] = ageingBuckets([
      { daysOverdue: 10, outstanding: 10_000 },
      { daysOverdue: 20, outstanding: 15_000 },
    ]);
    expect(bucket.count).toBe(2);
    expect(bucket.amount).toBe(25_000);
  });

  it('returns bands from not-due through most overdue', () => {
    const result = ageingBuckets([
      { daysOverdue: 200, outstanding: 1 },
      { daysOverdue: 0, outstanding: 1 },
      { daysOverdue: 45, outstanding: 1 },
    ]);
    expect(result.map((b) => b.key)).toEqual(['current', 'd31_60', 'd90plus']);
  });

  it('omits bands with nothing outstanding, and returns empty for no rows', () => {
    expect(ageingBuckets([])).toEqual([]);
    expect(ageingBuckets([{ daysOverdue: 5, outstanding: 0 }])).toEqual([]);
  });

  it('only ever returns a band the UI knows about, with a label', () => {
    const result = ageingBuckets([{ daysOverdue: 500, outstanding: 10 }]);
    expect(AGING_BUCKETS.map((b) => b.key)).toContain(result[0].key);
    expect(result[0].label).toBeTruthy();
  });
});

describe('amountInWords', () => {
  it('handles zero', () => {
    expect(amountInWords(0)).toBe('Rupees Zero Only');
  });

  it('writes a plain rupee amount', () => {
    expect(amountInWords(1)).toBe('Rupees One Only');
    expect(amountInWords(45)).toBe('Rupees Forty Five Only');
  });

  it('handles hundreds', () => {
    expect(amountInWords(100)).toBe('Rupees One Hundred Only');
    expect(amountInWords(999)).toBe('Rupees Nine Hundred Ninety Nine Only');
  });

  it('handles thousands, lakhs and crores in Indian grouping', () => {
    expect(amountInWords(1_000)).toBe('Rupees One Thousand Only');
    expect(amountInWords(1_00_000)).toBe('Rupees One Lakh Only');
    expect(amountInWords(1_00_00_000)).toBe('Rupees One Crore Only');
  });

  it('writes a real property value end to end', () => {
    expect(amountInWords(1_25_00_000)).toBe('Rupees One Crore Twenty Five Lakh Only');
    expect(amountInWords(2_45_67_890)).toBe('Rupees Two Crore Forty Five Lakh Sixty Seven Thousand Eight Hundred Ninety Only');
  });

  it('appends paise when there are any', () => {
    expect(amountInWords(100.5)).toBe('Rupees One Hundred and Fifty Paise Only');
  });

  it('carries a rounded-up paise into the rupee total', () => {
    // 1.999 must not print "one and undefined Paise" or silently become 1.
    expect(amountInWords(1.999)).toBe('Rupees Two Only');
  });

  it('refuses to print words for a negative or non-finite amount', () => {
    expect(amountInWords(-500)).toBe('Rupees Zero Only');
    expect(amountInWords(Number.NaN)).toBe('Rupees Zero Only');
    expect(amountInWords(Number.POSITIVE_INFINITY)).toBe('Rupees Zero Only');
  });

  it('never leaves a double space for a missing middle group', () => {
    expect(amountInWords(1_00_00_001)).toBe('Rupees One Crore One Only');
  });
});
