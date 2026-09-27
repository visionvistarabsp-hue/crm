import { readFileSync } from 'node:fs';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from './index';
import { applyConstraints } from './constraints';

/**
 * Drizzle applies a migration only when `last_applied.created_at <
 * entry.when`. A hand-edited or hand-written journal entry whose `when` sits in
 * the future therefore blocks every later migration *silently* - the command
 * still reports success. Fail loudly instead.
 */
function assertJournalTimestampsSane(folder: string): void {
  const journal = JSON.parse(readFileSync(`${folder}/meta/_journal.json`, 'utf8')) as {
    entries: Array<{ idx: number; tag: string; when: number }>;
  };
  const now = Date.now();
  let prev = -Infinity;

  for (const e of journal.entries) {
    if (e.when > now) {
      throw new Error(
        `Migration "${e.tag}" has a future timestamp (${e.when} > ${now}). ` +
          'Drizzle would skip it and every migration after it without warning. ' +
          `Fix its "when" in ${folder}/meta/_journal.json.`,
      );
    }
    if (e.when <= prev) {
      throw new Error(
        `Migration "${e.tag}" is not newer than the entry before it. ` +
          `Drizzle applies by ascending timestamp, so ordering must be monotonic.`,
      );
    }
    prev = e.when;
  }
}

async function main() {
  const folder = './drizzle';
  console.log('Running migrations against Neon...');
  assertJournalTimestampsSane(folder);
  await migrate(db, { migrationsFolder: folder });
  await applyConstraints();
  console.log('Migrations + constraints applied.');
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});