import { describe, it, expect } from 'vitest';
import { calcCommission, slabCommission, type CommissionRuleParams } from '@/lib/services/commissions';

const base = { saleValue: 10_000_000, collected: 2_000_000 };

describe('slabCommission', () => {
  it('returns 0 for empty slabs', () => {
    expect(slabCommission([], 10_000_000)).toBe(0);
  });

  it('handles negative max slabs', () => {
    expect(slabCommission([{ max: -100, rate: 5 }], 100)).toBe(0);
  });

  it('computes brackets independently of input order', () => {
    const slabs = [
      { max: 40_000_000, rate: 1 },
      { max: 10_000_000, rate: 2 },
    ];
    expect(slabCommission(slabs, 10_000_000)).toBe(200_000);
    expect(slabCommission([...slabs].reverse(), 10_000_000)).toBe(200_000);
  });

  it('only charges up to the base amount', () => {
    const slabs = [{ max: 20_000_000, rate: 2 }];
    expect(slabCommission(slabs, 10_000_000)).toBe(200_000);
  });

  it('uses the final slab rate for overflow beyond the last bracket', () => {
    const slabs = [
      { max: 10_000_000, rate: 2 },
      { max: 20_000_000, rate: 3 },
    ];
    // 2% on first 10m + 3% on next 10m
    expect(slabCommission(slabs, 20_000_000)).toBe(500_000);
  });

  it('supports fixed amounts per slab', () => {
    const slabs = [{ max: 10_000_000, rate: 2, fixed: 150_000 }];
    expect(slabCommission(slabs, 8_000_000)).toBe(150_000);
  });
});

describe('calcCommission', () => {
  it('computes FIXED commission', () => {
    const r = calcCommission({ type: 'FIXED', fixedAmount: '25000' }, base);
    expect(r.amount).toBe(25_000);
    expect(r.basis).toBe('SALE_VALUE');
    expect(r.baseAmount).toBe(10_000_000);
  });

  it('computes PERCENTAGE commission on sale value', () => {
    const r = calcCommission({ type: 'PERCENTAGE', rate: '2' }, base);
    expect(r.amount).toBe(200_000);
    expect(r.basis).toBe('SALE_VALUE');
  });

  it('computes SALE_VALUE_BASED commission', () => {
    const r = calcCommission({ type: 'SALE_VALUE_BASED', rate: 1.5 }, base);
    expect(r.amount).toBe(150_000);
  });

  it('computes COLLECTION_BASED commission on collected funds', () => {
    const r = calcCommission({ type: 'COLLECTION_BASED', rate: '5' }, base);
    expect(r.amount).toBe(100_000);
    expect(r.basis).toBe('COLLECTION');
    expect(r.baseAmount).toBe(2_000_000);
  });

  it('delegates SLAB_BASED to slabCommission', () => {
    const rule: CommissionRuleParams = {
      type: 'SLAB_BASED',
      slabConfig: [
        { max: 10_000_000, rate: 2 },
        { max: 20_000_000, rate: 3 },
      ],
    };
    const r = calcCommission(rule, base);
    expect(r.amount).toBe(200_000);
  });

  it('treats missing rates as 0 and string numerics correctly', () => {
    expect(calcCommission({ type: 'PERCENTAGE' }, base).amount).toBe(0);
    expect(calcCommission({ type: 'PERCENTAGE', rate: '2.5' }, base).amount).toBe(250_000);
  });

  it('defaults unknown types to sale-value percentage', () => {
    const r = calcCommission({ type: 'WHATEVER', rate: 2 } as CommissionRuleParams, base);
    expect(r.amount).toBe(200_000);
  });
});