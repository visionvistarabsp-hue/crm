import { sql, getTableName } from 'drizzle-orm';
import { db, pool } from './index';
import * as t from './schema';
import { hashPassword } from '../password';
import { ensureAdminUser } from './ensure-admin';
import { generateDataset, type Dataset } from './seed-generate';

/** Shared password for every seeded demo account, so the data is actually usable. */
const SEED_PASSWORD = 'SalesPoint@123';
const SEED = 20260215;
/** Postgres caps a statement at ~65535 bind params; 300 wide rows stays well clear. */
const CHUNK = 300;

/** Tables the demo dataset writes. `stats` is a summary, not a table. */
type DemoTable = Exclude<keyof Dataset, 'stats'>;
type Rows = Array<Record<string, unknown>>;

/** Untyped insert handle — Drizzle can't express a union of table types. */
type Inserter = { insert: (table: unknown) => { values: (rows: unknown) => Promise<unknown> } };

/**
 * Tables the demo dataset owns. `users` and `sessions` are deliberately absent:
 * the bootstrap super-admin and their live session must survive a reseed.
 * TRUNCATE ... CASCADE resolves the child -> parent order for us, so this list
 * only has to be complete, not ordered.
 */
const DEMO_TABLES: DemoTable[] = [
  'auditLogs', 'automationRules', 'backgroundJobs', 'bookings', 'cancellations',
  'commissionAdjustments', 'commissionLedger', 'commissionRules',
  'commissionSnapshots', 'counters', 'customers', 'documents', 'expenses',
  'followups', 'incomingLeads', 'integrations', 'leadActivities',
  'leadAssignments', 'leadDuplicates', 'leadStatusHistory', 'leads', 'meetings',
  'notifications', 'payments', 'payoutBatches', 'payoutTransactions', 'projects',
  'refunds', 'settings', 'towers', 'units',
];

/** Parent-before-child, so no insert trips a foreign key. */
const INSERT_ORDER: DemoTable[] = [
  'users', 'projects', 'towers', 'units', 'leads', 'customers',
  'leadActivities', 'leadStatusHistory', 'leadDuplicates', 'leadAssignments',
  'incomingLeads', 'followups', 'meetings', 'bookings', 'cancellations',
  'payments', 'refunds', 'expenses', 'documents', 'commissionRules',
  'commissionSnapshots', 'commissionAdjustments', 'commissionLedger',
  'payoutBatches', 'payoutTransactions', 'notifications', 'automationRules',
  'integrations', 'auditLogs', 'backgroundJobs', 'counters', 'settings',
];

const FORCE = process.argv.includes('--force');

// A new dataset table or a renamed export must fail here, not halfway through a
// destructive transaction.
for (const name of new Set([...DEMO_TABLES, ...INSERT_ORDER])) {
  const table = (t as Record<string, unknown>)[name];
  if (!table || typeof table !== 'object') {
    throw new Error(`schema.ts has no export named "${name}"`);
  }
}
const covered = new Set<string>(INSERT_ORDER);
const missing = DEMO_TABLES.filter((n) => !covered.has(n));
if (missing.length) throw new Error(`DEMO_TABLES not in INSERT_ORDER: ${missing.join(', ')}`);
if (covered.has('sessions')) throw new Error('sessions must never be reseeded');

/** Export name -> real (snake_case) table name. Never hand-write these. */
const sqlName = (name: DemoTable) => getTableName(t[name]);

async function countRows(name: DemoTable): Promise<number> {
  const res = await db.execute(
    sql.raw(`select count(*)::int as n from "${sqlName(name)}"`),
  );
  return (res as unknown as { rows: Array<{ n: number }> }).rows[0].n;
}

/**
 * Rows sitting in every table a reseed would truncate, in one round trip.
 *
 * The old guard only counted `leads`, so a database holding real customers,
 * audit history or payout batches but zero leads sailed straight through and
 * lost everything to TRUNCATE ... CASCADE. Any populated table is now enough
 * to stop the run.
 */
async function populatedTables(): Promise<{ table: string; n: number }[]> {
  const res = await db.execute(
    sql.raw(
      DEMO_TABLES
        .map((n) => `select '${sqlName(n)}'::text as table, count(*)::int as n from "${sqlName(n)}"`)
        .join('\nunion all\n'),
    ),
  );
  const out = (res as unknown as { rows?: Array<{ table: string; n: number }> }).rows ?? [];
  return out.filter((r) => r.n > 0).sort((a, b) => b.n - a.n);
}

async function main() {
  const admin = await ensureAdminUser();
  const populated = await populatedTables();
  const totalRows = populated.reduce((s, r) => s + r.n, 0);

  if (totalRows > 0 && !FORCE) {
    const shown = populated.slice(0, 8).map((r) => `${r.table}=${r.n}`).join(', ');
    const rest = populated.length > 8 ? `, +${populated.length - 8} more` : '';
    console.log(
      `Refusing to overwrite ${totalRows} existing row(s) across ${populated.length} table(s): ${shown}${rest}`,
    );
    console.log('Re-run with --force to wipe demo data.');
    console.log(`Bootstrap super-admin ${admin.email} is ready.`);
    await pool.end();
    return;
  }

  const passwordHash = await hashPassword(SEED_PASSWORD);
  const ds = generateDataset({ seed: SEED, passwordHash });

  // Demo-mode writes (AUTH_DEMO_MODE=true) use actor id 'demo', which needs a
  // real row for FK integrity. The generator stays free of auth concerns.
  (ds.users as Array<Record<string, unknown>>).push({
    id: 'demo',
    name: 'Demo Admin',
    email: 'demo@salespoint.in',
    role: 'SUPER_ADMIN',
    phone: '+91 9000000000',
    managerId: null,
    isActive: true,
    passwordHash,
  });

  if (totalRows > 0) {
    console.log(`Wiping ${totalRows} existing row(s) in ${populated.length} table(s) (--force).`);
  }

  await db.transaction(async (tx) => {
    await tx.execute(
      sql.raw(`TRUNCATE TABLE ${DEMO_TABLES.map(sqlName).map((n) => `"${n}"`).join(', ')} CASCADE`),
    );
    // Only the demo roster goes; the operator's login and session stay intact.
    await tx.execute(sql`DELETE FROM "users" WHERE "id" <> ${admin.id}`);

    for (const name of INSERT_ORDER) {
      const rows = ds[name] as Rows | undefined;
      if (!rows?.length) continue;
      const inserter = (tx as unknown as Inserter).insert(t[name]);
      for (let i = 0; i < rows.length; i += CHUNK) {
        await inserter.values(rows.slice(i, i + CHUNK));
      }
    }
  });

  console.log('\nSeeded:');
  let total = 0;
  for (const name of INSERT_ORDER) {
    const want = (ds[name] as Rows | undefined)?.length ?? 0;
    if (!want) continue;
    // The bootstrap super-admin survives the reseed, so `users` legitimately
    // holds one row more than the dataset produced.
    const expected = want + (name === 'users' ? 1 : 0);
    const got = await countRows(name);
    total += got;
    if (got !== expected) throw new Error(`${name}: inserted ${got}, expected ${expected}`);
    console.log(
      `  ${name.padEnd(22)} ${String(got).padStart(4)}` +
        (got !== want ? `  (${want} seeded + 1 preserved admin)` : ''),
    );
  }
  console.log(`  ${'TOTAL'.padEnd(22)} ${String(total).padStart(4)}`);

  console.log(`
Sign in at /login
  demo team     admin@salespoint.in … docs@salespoint.in  (${SEED_PASSWORD})
  bootstrap     ${admin.email} (${admin.passwordSet ? 'password set' : 'unchanged'})`);
  console.log(`Demo mode actor id "demo" is present for AUTH_DEMO_MODE writes.`);

  await pool.end();
}

main().catch(async (err) => {
  console.error('Seed failed:', err);
  await pool.end().catch(() => {});
  process.exit(1);
});
