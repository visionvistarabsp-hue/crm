import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env first.');
}

const globalForDb = globalThis as unknown as { pool?: Pool; db?: ReturnType<typeof createDb> };

function createPool(): Pool {
  return new Pool({
    connectionString,
    max: 20,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
  });
}

function createDb() {
  const pool = globalForDb.pool ?? createPool();
  globalForDb.pool = pool;
  return drizzle(pool, { schema });
}

export const db = globalForDb.db ?? createDb();
globalForDb.db = db;

// Re-export pool so migrations/tools can use it directly
export const pool: Pool = globalForDb.pool!;

export * from './schema';