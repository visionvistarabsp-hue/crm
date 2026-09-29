import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  encryptSecret,
  decryptSecret,
  generateEncryptionKey,
  isSecretEncryptionConfigured,
  looksEncrypted,
  maskSecret,
} from '@/lib/secrets';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

describe('secret encryption', () => {
  const original = process.env.SETTINGS_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.SETTINGS_ENCRYPTION_KEY = KEY_A;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY;
    else process.env.SETTINGS_ENCRYPTION_KEY = original;
  });

  it('round-trips a secret through encrypt/decrypt', () => {
    const ciphertext = encryptSecret('re_1234567890abcdef');
    expect(decryptSecret(ciphertext)).toBe('re_1234567890abcdef');
  });

  it('round-trips unicode and empty-ish payloads', () => {
    const value = 'clé-値-🔐';
    expect(decryptSecret(encryptSecret(value))).toBe(value);
  });

  it('emits the v1 envelope so stored rows stay self-describing', () => {
    const ciphertext = encryptSecret('x');
    expect(ciphertext.split(':')).toHaveLength(4);
    expect(ciphertext.startsWith('v1:')).toBe(true);
    expect(looksEncrypted(ciphertext)).toBe(true);
  });

  it('never leaks the plaintext into the stored envelope', () => {
    const plaintext = 'super-secret-resend-key';
    expect(encryptSecret(plaintext)).not.toContain(plaintext);
  });

  it('uses a fresh IV, so the same plaintext encrypts differently each time', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });

  it('refuses to encrypt an empty secret', () => {
    expect(() => encryptSecret('')).toThrow();
  });

  it('reports a wrong key instead of returning garbage plaintext', () => {
    const ciphertext = encryptSecret('payload');
    process.env.SETTINGS_ENCRYPTION_KEY = KEY_B;
    expect(() => decryptSecret(ciphertext)).toThrow(/SETTINGS_ENCRYPTION_KEY/);
  });

  it('rejects a tampered ciphertext via the auth tag', () => {
    const [prefix, iv, tag, body] = encryptSecret('payload').split(':');
    const flipped = Buffer.from(body, 'base64');
    flipped[0] ^= 0xff;
    expect(() => decryptSecret([prefix, iv, tag, flipped.toString('base64')].join(':'))).toThrow();
  });

  it('rejects a malformed envelope rather than guessing', () => {
    expect(() => decryptSecret('not-encrypted')).toThrow();
    expect(() => decryptSecret('v2:a:b:c')).toThrow();
  });

  it('treats a missing or wrong-length key as not configured', () => {
    delete process.env.SETTINGS_ENCRYPTION_KEY;
    expect(isSecretEncryptionConfigured()).toBe(false);
    process.env.SETTINGS_ENCRYPTION_KEY = 'too-short';
    expect(isSecretEncryptionConfigured()).toBe(false);
    expect(isSecretEncryptionConfigured()).toBe(false);
  });

  it('accepts a generated key', () => {
    process.env.SETTINGS_ENCRYPTION_KEY = generateEncryptionKey();
    expect(isSecretEncryptionConfigured()).toBe(true);
    expect(decryptSecret(encryptSecret('ok'))).toBe('ok');
  });

  it('masks without revealing the middle of a long secret', () => {
    const masked = maskSecret('re_ABCDEFGHIJKLMNOP');
    expect(masked.startsWith('re_ABCD')).toBe(true);
    expect(masked).not.toContain('EFGHIJKL');
    expect(maskSecret('short')).toBe('set (hidden)');
    expect(maskSecret(null)).toBe('not set');
  });
});
