import { promises as fs } from 'node:fs';
import path from 'node:path';
import { StorageBackend } from './index';

const FALLBACK_DIR = '.local-storage';

export class LocalStorage implements StorageBackend {
  private dir: string;

  constructor() {
    this.dir = process.env.LOCAL_STORAGE_DIR || FALLBACK_DIR;
  }

  private resolve(key: string): string {
    const p = path.resolve(this.dir, key);
    if (!p.startsWith(path.resolve(this.dir))) {
      throw new Error('Invalid storage key');
    }
    return p;
  }

  async put(key: string, body: Buffer, _mimeType: string): Promise<void> {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.resolve(key));
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(this.resolve(key));
    } catch {
      /* noop */
    }
  }

  async getSignedUrl(): Promise<string | null> {
    // Local storage is served through the authenticated /api/documents/file proxy.
    return null;
  }

  usesProxy(): boolean {
    return true;
  }
}