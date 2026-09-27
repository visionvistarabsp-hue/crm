import { describe, it, expect } from 'vitest';
import { monthLabel, clamp, pct, num, pad } from '@/lib/utils';

describe('monthLabel', () => {
  it('renders a YYYY-MM bucket as a short axis label', () => {
    expect(monthLabel('2026-09')).toBe('Sep 26');
  });

  it('zero-pads single-digit months', () => {
    expect(monthLabel('2026-01')).toBe('Jan 26');
  });

  it('crosses a year boundary unambiguously', () => {
    // A six-month window straddling New Year must not render two bare "Jan"s.
    expect(monthLabel('2025-12')).toBe('Dec 25');
    expect(monthLabel('2026-01')).toBe('Jan 26');
  });

  it('stays unique across a twelve-month span', () => {
    const keys = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`);
    const labels = keys.map(monthLabel);
    expect(new Set(labels).size).toBe(keys.length);
  });

  it('degrades to an em dash instead of leaking Invalid Date', () => {
    expect(monthLabel('2026-13')).toBe('—');
    expect(monthLabel('not-a-month')).toBe('—');
    expect(monthLabel('')).toBe('—');
    expect(monthLabel(null)).toBe('—');
    expect(monthLabel(undefined)).toBe('—');
  });

  it('rejects the shapes a bucket key must never have', () => {
    // The key is also used as a React key, so a bare year or full date must
    // not be mistaken for a valid month.
    expect(monthLabel('2026')).toBe('—');
    expect(monthLabel('2026-09-01')).toBe('—');
  });
});

describe('clamp', () => {
  it('bounds both ends', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });
});

describe('pct', () => {
  it('avoids dividing by zero', () => {
    expect(pct(1, 0)).toBe('0%');
  });

  it('computes a percentage', () => {
    expect(pct(1, 4, 0)).toBe('25%');
  });
});

describe('num', () => {
  it('coerces junk to zero', () => {
    expect(num(null)).toBe(0);
    expect(num(undefined)).toBe(0);
    expect(num('abc')).toBe(0);
    expect(num('12.5')).toBe(12.5);
  });
});

describe('pad', () => {
  it('zero-pads to width', () => {
    expect(pad(7, 4)).toBe('0007');
    expect(pad(1234, 4)).toBe('1234');
  });
});
