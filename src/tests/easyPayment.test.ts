import { describe, it, expect } from 'vitest';
import { recordEasyPayment } from '@/lib/services/easy';
import type { Actor } from '@/lib/api';
import { PAYMENT_METHODS } from '@/lib/constants';

/**
 * Every check here runs before `recordEasyPayment` touches the database, so the
 * validation contract can be pinned without a Postgres instance. Getting these
 * wrong is expensive in both directions: a rejected valid payment loses a real
 * collection, and an accepted bad one writes an unreconcilable receipt.
 */
const actor = { user: { id: 'u1' } } as unknown as Actor;
const base = { customerId: 'c1', method: 'CASH', amount: 1000 } as const;

async function expectRejection(input: Record<string, unknown>) {
  try {
    await recordEasyPayment(actor, input as never);
  } catch (err) {
    return err as { status: number; code?: string; message: string };
  }
  throw new Error('expected recordEasyPayment to reject, but it resolved');
}

describe('recordEasyPayment validation', () => {
  it('rejects a zero amount', async () => {
    const err = await expectRejection({ ...base, amount: 0 });
    expect(err.status).toBe(422);
    expect(err.code).toBe('VALIDATION');
  });

  it('rejects a negative amount', async () => {
    const err = await expectRejection({ ...base, amount: -500 });
    expect(err.status).toBe(422);
    expect(err.code).toBe('VALIDATION');
  });

  it('rejects a sub-paisa amount that rounds to nothing', async () => {
    // Guards the case where a typo like 0.004 would otherwise post a 0.00
    // receipt against the customer and still mark progress on the due.
    const err = await expectRejection({ ...base, amount: '0.004' });
    expect(err.status).toBe(422);
    expect(err.code).toBe('VALIDATION');
  });

  it('rejects a missing payment method', async () => {
    const err = await expectRejection({ amount: 1000, customerId: 'c1' });
    expect(err.status).toBe(422);
    expect(err.code).toBe('VALIDATION');
  });

  it('rejects an empty-string payment method', async () => {
    const err = await expectRejection({ ...base, method: '' });
    expect(err.status).toBe(422);
    expect(err.code).toBe('VALIDATION');
  });

  it('rejects a payment with neither a due, a customer, nor a lead', async () => {
    // Without one of these there is nothing to attach the money to, so the
    // receipt would be orphaned.
    const err = await expectRejection({ amount: 1000, method: 'CASH' });
    expect(err.status).toBe(422);
    expect(err.code).toBe('VALIDATION');
    expect(err.message).toMatch(/pending payment|customer/i);
  });

  it('reports the amount error first when the request is wrong in two ways', async () => {
    // Ordering matters: an agent who typed 0 and forgot to pick a customer
    // should be told about the amount first, since that is the more likely
    // typo and the one that silently loses the receipt if left unfixed.
    const err = await expectRejection({ amount: 0, method: 'CASH' });
    expect(err.status).toBe(422);
    expect(err.message).toMatch(/amount/i);
  });

  it('reports the method error before the missing-target error', async () => {
    const err = await expectRejection({ amount: 1000 });
    expect(err.status).toBe(422);
    expect(err.message).toMatch(/method/i);
  });
});

describe('PAYMENT_METHODS', () => {
  it('matches the methods the payment schema accepts', () => {
    // The easy screen renders exactly this list, so a method outside it would
    // reach recordPayment and violate the payments.status check constraint.
    expect(PAYMENT_METHODS).toContain('CASH');
    expect(PAYMENT_METHODS).toContain('UPI');
    expect(PAYMENT_METHODS).not.toContain('OTHER');
  });

  it('exposes only distinct values', () => {
    expect(new Set(PAYMENT_METHODS).size).toBe(PAYMENT_METHODS.length);
  });
});
