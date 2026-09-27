/**
 * Standalone, idempotent bootstrap of the built-in super-admin account.
 * Run with:  npm run db:ensure-admin
 *
 * Safe to run repeatedly — it only creates the account, or fills in a missing
 * password / repairs the role on an existing one.
 */
import { pool } from './index';
import { ensureAdminUser, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD } from './ensure-admin';

async function main() {
  const result = await ensureAdminUser();
  console.log(
    result.created
      ? `Created super-admin ${result.email}`
      : `Super-admin ${result.email} already exists${result.passwordSet ? ' — password set' : ' (left unchanged)'}`,
  );
  console.log(`  Sign in at /login with ${result.email}`);
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to ensure admin user:', err);
  process.exit(1);
});

export { DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD };
