import { randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(_scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * scrypt parameters. N=16384 / r=8 / p=1 is the interactive-login profile
 * (~16 MB, ~50-80 ms per hash on server hardware). The values are stored
 * inside every digest, so raising them later still verifies old passwords.
 */
const PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEYLEN = 64;
const SALT_BYTES = 16;
// scrypt needs 128 * N * r bytes; give it headroom so Node never rejects the call.
const MAXMEM = 128 * PARAMS.N * PARAMS.r * 2;

const ALGO = 'scrypt';

// Policy lives in a separate module so client components can share it without
// dragging node:crypto into the browser bundle.
export { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH, checkPasswordPolicy, type PasswordProblem } from './password-policy';

/** A digest that matches nothing, used to keep "no such user" as slow as a wrong password. */
const DUMMY_DIGEST = (() => {
  const salt = Buffer.alloc(SALT_BYTES, 7).toString('base64');
  const hash = Buffer.alloc(KEYLEN, 7).toString('base64');
  return `${ALGO}$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt}$${hash}`;
})();

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { ...PARAMS, maxmem: MAXMEM });
  return [ALGO, PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

/**
 * Constant-time verification. Returns false (rather than throwing) for any
 * digest that is malformed or was produced with unknown parameters.
 */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) {
    // Still burn equivalent CPU so a missing account is not distinguishable by timing.
    await verifyPassword(password, DUMMY_DIGEST).catch(() => false);
    return false;
  }

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== ALGO) return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // Refuse absurd parameters from a tampered/legacy row rather than OOM the process.
  if (N > 1_048_576 || r > 32 || p > 16) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, 'base64');
    expected = Buffer.from(parts[5]!, 'base64');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      maxmem: Math.max(MAXMEM, 128 * N * r * 2),
    });
  } catch {
    return false;
  }

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
