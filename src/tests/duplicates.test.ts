import { describe, it, expect } from 'vitest';
import { detectDuplicateCandidates } from '@/lib/services/duplicates';
import { normalizePhone, normalizeEmail } from '@/lib/utils';

describe('normalizePhone / normalizeEmail', () => {
  it('strips formatting and drops leading 91/0 for Indian numbers', () => {
    expect(normalizePhone('+91 98765 43210')).toBe('9876543210');
    expect(normalizePhone('0 9876543210')).toBe('9876543210');
    expect(normalizePhone('98765-43210')).toBe('9876543210');
    expect(normalizePhone('1298765432109')).toBeNull(); // >12 digits
    expect(normalizePhone(null)).toBeNull();
  });

  it('normalizes email case and whitespace', () => {
    expect(normalizeEmail('  Ravi.@Example.COM ')).toBe('ravi.@example.com');
    expect(normalizeEmail('not-an-email')).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
  });
});

describe('detectDuplicateCandidates', () => {
  const existing = [
    { phone: '+91 98765 43210', email: 'Ravi@Example.com' },        // idx 0
    { whatsapp: '9876543211', email: 'other@x.com' },               // idx 1
    { phone: '919876543212', email: 'third@x.com' },                // idx 2 (91 prefix)
  ];

  it('matches on phone with confidence 100', () => {
    const res = detectDuplicateCandidates({ phone: '98765 43210' }, existing);
    expect(res).toEqual([{ index: 0, match: { rule: 'PHONE', confidence: 100 } }]);
  });

  it('matches whatsapp fallback to existing whatsapp with confidence 95', () => {
    const res = detectDuplicateCandidates({ whatsapp: '+919876543211' }, existing);
    expect(res).toEqual([{ index: 1, match: { rule: 'PHONE', confidence: 95 } }]);
  });

  it('normalises 91-prefixed phone numbers before comparing', () => {
    const res = detectDuplicateCandidates({ phone: '9876543212' }, existing);
    expect(res).toEqual([{ index: 2, match: { rule: 'PHONE', confidence: 100 } }]);
  });

  it('matches on normalized email', () => {
    const res = detectDuplicateCandidates({ email: 'ravi@example.com' }, existing);
    expect(res).toEqual([{ index: 0, match: { rule: 'EMAIL', confidence: 100 } }]);
  });

  it('returns empty when no match exists', () => {
    expect(detectDuplicateCandidates({ phone: '9999999999', email: 'nobody@x.com' }, existing)).toEqual([]);
  });

  it('handles null candidate fields gracefully', () => {
    expect(detectDuplicateCandidates({ phone: null, email: null }, existing)).toEqual([]);
  });
});