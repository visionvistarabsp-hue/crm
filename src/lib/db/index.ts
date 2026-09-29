import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env first.');
}

const globalForDb = globalThis as unknown as { pool?: Pool; db?: ReturnType<typeof createDb> };

function createPool(): Pool {
  // On Vercel every serverless invocation opens its own pool, so a large
  // per-instance max multiplies across concurrent lambdas and exhausts the
  // database plan. Keep it small there and let the env override for a
  // long-lived Node process or a bigger plan.
  const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  const configured = Number(process.env.DB_POOL_MAX);
  const max = Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : isServerless ? 2 : 20;

  return new Pool({
    connectionString,
    max,
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