import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PREFIX = 'v1';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SecretConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretConfigError';
  }
}

function masterKey(): Buffer {
  const raw = process.env.SETTINGS_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new SecretConfigError('SETTINGS_ENCRYPTION_KEY is not set');
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  if (/^[A-Za-z0-9+/]{43}=*$/.test(raw)) {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32) return decoded;
  }
  throw new SecretConfigError(
    'SETTINGS_ENCRYPTION_KEY must be 32 bytes, supplied as 64 hex characters or base64',
  );
}

export function isSecretEncryptionConfigured(): boolean {
  try {
    masterKey();
    return true;
  } catch {
    return false;
  }
}

export function generateEncryptionKey(): string {
  return randomBytes(32).toString('hex');
}

export function encryptSecret(plaintext: string): string {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new SecretConfigError('Refusing to encrypt an empty secret');
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    PREFIX,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

export function decryptSecret(stored: string): string {
  if (typeof stored !== 'string') {
    throw new SecretConfigError('Stored secret is not a string');
  }
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new SecretConfigError('Stored secret is not in the expected v1 format');
  }
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const ciphertext = Buffer.from(parts[3], 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new SecretConfigError('Stored secret has a malformed header');
  }
  try {
    const decipher = createDecipheriv(ALGO, masterKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretConfigError(
      'Stored secret could not be decrypted; SETTINGS_ENCRYPTION_KEY does not match the value it was saved with',
    );
  }
}

export function looksEncrypted(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(`${PREFIX}:`);
}

export function maskSecret(value: string | null | undefined): string {
  if (!value) return 'not set';
  if (value.length <= 12) return 'set (hidden)';
  return `${value.slice(0, 7)}${'*'.repeat(8)}${value.slice(-4)}`;
}
