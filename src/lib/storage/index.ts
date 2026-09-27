import { createHash } from 'node:crypto';

// ------------------------------------------------------------------
// Storage abstraction.
// Private customer documents are stored in Cloudflare R2 (S3-compatible).
// When R2 is not configured the app falls back to the local filesystem
// (development only) served through an authenticated proxy route.
// ------------------------------------------------------------------

export interface StorageBackend {
  put(key: string, body: Buffer, mimeType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  /** Signed/expiring download URL. Returns null when proxying is required. */
  getSignedUrl(key: string, expiresInSec?: number): Promise<string | null>;
  /** True if the backend serves private objects via the internal proxy. */
  usesProxy(): boolean;
}

export const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/heic',
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

export const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

export function hashFile(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

export function sanitizeKey(base: string): string {
  return base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-');
}

let _backend: StorageBackend | null = null;

export function getStorage(): StorageBackend {
  if (_backend) return _backend;
  if (process.env.R2_ENDPOINT && process.env.R2_BUCKET) {
    // dynamic import to keep AWS SDK out of the server bundle when unused
    const { R2Storage } = require('./s3') as typeof import('./s3');
    _backend = new R2Storage();
  } else {
    const { LocalStorage } = require('./local') as typeof import('./local');
    _backend = new LocalStorage();
  }
  return _backend;
}

export function storageConfigured(): 'r2' | 'local' {
  return process.env.R2_ENDPOINT && process.env.R2_BUCKET ? 'r2' : 'local';
}