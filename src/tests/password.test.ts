import { describe, it, expect } from 'vitest';
import { scryptSync, randomBytes } from 'node:crypto';
import {
  hashPassword, verifyPassword, checkPasswordPolicy, MIN_PASSWORD_LENGTH,
} from '@/lib/password';

describe('hashPassword / verifyPassword', () => {
  it('round-trips a password', async () => {
    const hash = await hashPassword('SalesPoint@123');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('SalesPoint@123', hash)).toBe(true);
  });

  it('never stores the plaintext and salts every hash', async () => {
    const hash = await hashPassword('SalesPoint@123');
    expect(hash).not.toContain('SalesPoint@123');
    // A unique salt per call means identical passwords must not collide.
    expect(hash).not.toBe(await hashPassword('SalesPoint@123'));
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('SalesPoint@123');
    expect(await verifyPassword('SalesPoint@124', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
    expect(await verifyPassword('salespoint@123', hash)).toBe(false);
  });

  it('rejects a missing digest without throwing', async () => {
    // `passwordHash` is nullable for the pre-existing accounts, so login must
    // treat null/empty as "no usable password" rather than crashing.
    expect(await verifyPassword('anything', null)).toBe(false);
    expect(await verifyPassword('anything', undefined)).toBe(false);
    expect(await verifyPassword('anything', '')).toBe(false);
  });

  it('rejects malformed digests instead of throwing', async () => {
    // These values come from a user-influenced column, so none may crash a login.
    const bad = [
      'x',
      'not-a-hash',
      'scrypt$16384$8$1',            // too few parts
      'scrypt$16384$8$1$a$b$c',      // too many parts
      'bcrypt$16384$8$1$AAAA$AAAA',  // unknown algorithm
      'scrypt$16384$8$1$!!$!!',      // not valid base64
      'scrypt$16384$8$1$QUJD',       // salt but no hash
    ];
    for (const digest of bad) {
      expect(await verifyPassword('anything', digest)).toBe(false);
    }
  });

  it('rejects absurd cost parameters from a tampered row', async () => {
    // N/r/p are attacker-reachable via a tampered row; without the guard this
    // would attempt a huge allocation instead of returning false.
    const absurd = 'scrypt$99999999$8$1$QUJDRA==$QUJDRA==';
    expect(await verifyPassword('anything', absurd)).toBe(false);
  });

  it('verifies a digest hashed with weaker parameters, so costs can be raised later', async () => {
    // The parameters live in the digest string, so an older/cheaper profile must
    // still authenticate after PARAMS is increased.
    const salt = randomBytes(16);
    const N = 1024, r = 8, p = 1;
    const legacy = ['scrypt', N, r, p, salt.toString('base64'),
      scryptSync('SalesPoint@123', salt, 64, { N, r, p, maxmem: 128 * N * r * 2 }).toString('base64'),
    ].join('$');
    expect(await verifyPassword('SalesPoint@123', legacy)).toBe(true);
    expect(await verifyPassword('wrong', legacy)).toBe(false);
  });

  it('normalizes unicode so equivalent forms match', async () => {
    // Both sides go through NFKC, so a canonically equivalent password verifies.
    const hash = await hashPassword('cafe\u0301@123');   // combining acute accent
    expect(await verifyPassword('caf\u00e9@123', hash)).toBe(true);
  });
});

describe('checkPasswordPolicy', () => {
  it('returns null when acceptable, a message otherwise', () => {
    expect(checkPasswordPolicy('SalesPoint@123')).toBeNull();
  });

  it('rejects short, empty, overlong and low-variety passwords', () => {
    expect(checkPasswordPolicy('a1b2')).toMatch(/at least/);
    expect(checkPasswordPolicy('')).toMatch(/at least/);
    expect(checkPasswordPolicy('a'.repeat(201))).toMatch(/at most/);
    expect(checkPasswordPolicy('alllettersonly')).toMatch(/number/);
    expect(checkPasswordPolicy('1234567890')).toMatch(/letter/);
  });

  it('rejects the documented bootstrap credential', () => {
    // crm123 is the shipped default admin password, set out-of-band by
    // db:ensure-admin. Signup policy must not let anyone pick it themselves.
    expect(checkPasswordPolicy('crm123')).toMatch(/at least/);
  });

  it('enforces the minimum length it advertises', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8);
  });
});
