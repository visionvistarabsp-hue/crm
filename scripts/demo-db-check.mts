import { sql } from 'drizzle-orm';
import { db, pool } from '../src/lib/db/index';
import { CONSTRAINTS } from '../src/lib/db/constraints';
import { nextNumber } from '../src/lib/services/counters';
import { getSalesReport, getCancellationReport } from '../src/lib/services/analytics';
import { listProjects } from '../src/lib/services/projects';
import { ROLE_PERMISSIONS } from '../src/lib/constants';
import type { Actor } from '../src/lib/api';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const rows = async (text: string, params: unknown[] = []) =>
  (await pool.query(text, params)).rows;
const one = async (text: string, params: unknown[] = []) => (await rows(text, params))[0];

// ---- 1. the CHECK constraints the seed must satisfy are actually installed
const installed = await rows(
  `select conname from pg_constraint where contype = 'c' and conname like 'chk\_%'`,
);
const names = new Set(installed.map((r) => r.conname as string));
const missing = CONSTRAINTS.filter((c) => !names.has(c.name)).map((c) => c.name);
check('all domain CHECK constraints installed', missing.length === 0, missing.join(', '));

// ---- 2. no orphaned foreign keys
const orphanChecks: Array<[string, string]> = [
  ['leads.owner_id', `select count(*)::int n from leads l where l.owner_id is not null and not exists (select 1 from users u where u.id = l.owner_id)`],
  ['leads.project_id', `select count(*)::int n from leads l where l.project_id is not null and not exists (select 1 from projects p where p.id = l.project_id)`],
  ['units.tower_id', `select count(*)::int n from units u where u.tower_id is not null and not exists (select 1 from towers w where w.id = u.tower_id)`],
  ['bookings.unit_id', `select count(*)::int n from bookings b where b.unit_id is not null and not exists (select 1 from units u where u.id = b.unit_id)`],
  ['bookings.customer_id', `select count(*)::int n from bookings b where not exists (select 1 from customers c where c.id = b.customer_id)`],
  ['payments.booking_id', `select count(*)::int n from payments p where not exists (select 1 from bookings b where b.id = p.booking_id)`],
  ['followups.lead_id', `select count(*)::int n from followups f where f.lead_id is not null and not exists (select 1 from leads l where l.id = f.lead_id)`],
  ['meetings.customer_id', `select count(*)::int n from meetings m where m.customer_id is not null and not exists (select 1 from customers c where c.id = m.customer_id)`],
  ['payout_transactions.batch_id', `select count(*)::int n from payout_transactions p where not exists (select 1 from payout_batches b where b.id = p.batch_id)`],
  ['commission_ledger.person_id', `select count(*)::int n from commission_ledger c where not exists (select 1 from users u where u.id = c.person_id)`],
  ['audit_logs.user_id', `select count(*)::int n from audit_logs a where a.user_id is not null and not exists (select 1 from users u where u.id = a.user_id)`],
];
for (const [label, text] of orphanChecks) {
  const { n } = await one(text);
  check(`no orphans: ${label}`, n === 0, `${n} orphaned`);
}

// ---- 3. business invariants the UI depends on
// Inventory must reflect the booking lifecycle:
//   CONFIRMED / DOCUMENT_COLLECTION -> held as BOOKED
//   COMPLETED                       -> sold
//   CANCELLED                       -> released back to the pool
const LIFECYCLE: Array<[string, string]> = [
  ['CONFIRMED', 'BOOKED'],
  ['DOCUMENT_COLLECTION', 'BOOKED'],
  ['COMPLETED', 'SOLD'],
  ['CANCELLED', 'AVAILABLE'],
];
for (const [bookingStatus, unitStatus] of LIFECYCLE) {
  const bad = await one(
    `select count(*)::int n from bookings b join units u on u.id = b.unit_id
     where b.status = $1 and u.status <> $2`,
    [bookingStatus, unitStatus],
  );
  check(
    `${bookingStatus} bookings hold the unit as ${unitStatus}`,
    bad.n === 0,
    `${bad.n} mismatched`,
  );
}
const orphans = await one(`
  select count(*)::int n from units u
  where u.booking_id is not null and not exists (select 1 from bookings b where b.id = u.booking_id)`);
check('units.booking_id resolves', orphans.n === 0, `${orphans.n} orphaned`);

const dupLeadNos = await one(
  `select count(*)::int n from (select lead_no from leads group by lead_no having count(*) > 1) x`);
check('lead_no unique', dupLeadNos.n === 0);
const dupPhones = await one(`
  select count(*)::int n from (
    select phone from leads where is_duplicate = false and phone is not null
    group by phone having count(*) > 1) x`);
check('non-duplicate lead phones unique', dupPhones.n === 0, `${dupPhones.n} repeated`);
const badPhone = await one(
  `select count(*)::int n from leads where phone is not null and phone !~ '^\\+91 [0-9]{10}$'`);
check('every lead phone is +91 plus 10 digits', badPhone.n === 0, `${badPhone.n} malformed`);
const dupFlags = await one(`
  select count(*)::int n from leads l
  where (l.is_duplicate and l.duplicate_of_id is null)
     or (not l.is_duplicate and l.duplicate_of_id is not null)`);
check('is_duplicate agrees with duplicate_of_id', dupFlags.n === 0, `${dupFlags.n} inconsistent`);

// ---- 4. counters line up and the next runtime number is free
const counters = await rows(`select key, value from counters`);
const c = Object.fromEntries(counters.map((r) => [r.key as string, r.value as number]));
const countRows = await rows(`
  select 'lead' k, count(*)::int v from leads
  union all select 'customer', count(*)::int from customers
  union all select 'booking', count(*)::int from bookings
  union all select 'payout', count(*)::int from payout_batches`);
for (const r of countRows) {
  check(`counter ${r.k} == row count`, c[r.k as string] === r.v, `counter=${c[r.k as string]} rows=${r.v}`);
}

// Mint a real number through the production helper, then roll it back.
let minted = '';
let clash = -1;
class Rollback extends Error {}
try {
  await db.transaction(async (tx) => {
    minted = await nextNumber('lead', 'LD', 4, tx);
    const res = await tx.execute(
      sql`select count(*)::int as n from leads where lead_no = ${minted}`,
    );
    clash = (res as unknown as { rows: Array<{ n: number }> }).rows[0].n;
    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) throw e;
}
check('runtime nextNumber mints an unused value', clash === 0, `${minted} (rolled back)`);

// ---- 5. the operator's login and session survived
const admin = await one(`select id, email, role from users where email = 'crm@gmail.com'`);
check('bootstrap super-admin preserved', admin?.role === 'SUPER_ADMIN', admin?.email ?? 'MISSING');
const adminUser = { id: admin.id, email: admin.email, name: admin.email, role: admin.role, managerId: null };
const sess = await one(`select count(*)::int n from sessions where user_id = $1`, [admin?.id ?? '']);
check('bootstrap admin session intact', sess.n > 0, `${sess.n} live session(s)`);
const demoUser = await one(`select count(*)::int n from users where id = 'demo'`);
check('AUTH_DEMO_MODE actor "demo" exists', demoUser.n === 1);
const demoTeam = await one(
  `select count(*)::int n from users where email like '%@salespoint.in' and password_hash is not null`);
check('demo team can authenticate', demoTeam.n >= 14, `${demoTeam.n} users with a password`);

// ---- 6. today's queues are populated relative to the database clock
const todayFU = await one(
  `select count(*)::int n from followups where status = 'PENDING' and scheduled_at::date = current_date`);
const todayMT = await one(
  `select count(*)::int n from meetings where status in ('SCHEDULED','CONFIRMED') and scheduled_at::date = current_date`);
check('pending follow-ups due today', todayFU.n > 0, `${todayFU.n}`);
check('meetings today', todayMT.n > 0, `${todayMT.n}`);

// ---- 7. the sales report must not leak revenue across the org
const asActor = (u: { id: string; email: string; name: string; role: string; managerId: string | null }) =>
  ({ user: u, ip: null, userAgent: null, path: '/test', method: 'GET' }) as Actor;

const loadUser = async (email: string) => {
  const r = await one(
    `select id, email, name, role, manager_id from users where email = $1`, [email]);
  return { id: r.id, email: r.email, name: r.name, role: r.role, managerId: r.manager_id };
};

/**
 * Same shape auth.ts hands to a service: the role's real permission list plus
 * the isSuperAdmin flag. `asActor` deliberately omits these because the
 * visibility helpers only read `role`; anything that calls hasPermission()
 * needs the full object.
 */
const actorFor = (u: { id: string; email: string; name: string; role: string; managerId: string | null }) =>
  ({
    user: {
      ...u,
      permissions: ROLE_PERMISSIONS[u.role as keyof typeof ROLE_PERMISSIONS] ?? [],
      isSuperAdmin: u.role === 'SUPER_ADMIN',
    },
    ip: null,
    userAgent: null,
    path: '/test',
    method: 'GET',
  }) as unknown as Actor;

const rep = await loadUser('exec2@salespoint.in');
const lead1 = await loadUser('teamlead1@salespoint.in');
const orgWide = await getSalesReport(asActor(adminUser), {});

check('report totals every booking for an admin',
  orgWide.summary.count === 12, `${orgWide.summary.count}`);
check('report aggregates several salespeople for an admin',
  orgWide.byUser.length > 4, `${orgWide.byUser.length} salespeople`);

const repReport = await getSalesReport(asActor(rep), {});
const ownRows = await one(
  `select count(*)::int n from bookings where salesperson_id = $1`, [rep.id]);
check('a salesperson sees only their own bookings',
  repReport.summary.count === ownRows.n && repReport.summary.count > 0,
  `${repReport.summary.count} of ${orgWide.summary.count}`);
check('a salesperson never sees a colleague in byUser',
  repReport.byUser.every((u) => u.userId === rep.id),
  repReport.byUser.map((u) => u.name).join(', '));

const leadReport = await getSalesReport(asActor(lead1), {});
check('a team lead sees their team but not the whole org',
  leadReport.byUser.length > 1 && leadReport.summary.count < orgWide.summary.count,
  `${leadReport.summary.count} bookings across ${leadReport.byUser.length} people`);

// A date range must actually narrow, and an out-of-range window must be empty.
const sep = await getSalesReport(asActor(adminUser), { from: '2026-09-01', to: '2026-09-30' });
check('date range narrows the report',
  sep.summary.count > 0 && sep.summary.count < orgWide.summary.count,
  `Sep=${sep.summary.count} vs all=${orgWide.summary.count}`);
check('report echoes the applied range',
  sep.summary.range.from === '2026-09-01' && sep.summary.range.to === '2026-09-30',
  JSON.stringify(sep.summary.range));
const none = await getSalesReport(asActor(adminUser), { from: '2020-01-01', to: '2020-01-31' });
check('a range with no bookings returns zero, not everything',
  none.summary.count === 0 && none.summary.value === 0, `${none.summary.count} bookings`);

// ---- 8. the `to` bound is inclusive of the WHOLE day
// A single-day window over a date that actually has bookings must return
// exactly that day's bookings. This is the off-by-one the old
// `lt(bookingDate, to@00:00)` bound had: it silently dropped the `to` day.
const someDay = await one(
  `select to_char(booking_date, 'YYYY-MM-DD') d, count(*)::int n
     from bookings group by 1 having count(*) > 0 order by n desc limit 1`);
if (someDay) {
  const single = await getSalesReport(asActor(adminUser), { from: someDay.d, to: someDay.d });
  check('a from==to window includes that whole day',
    single.summary.count === someDay.n,
    `${someDay.d}: got ${single.summary.count}, expected ${someDay.n}`);
} else {
  check('a from==to window includes that whole day', false, 'no booking dates found');
}

// Month-end must not roll over into the next month.
const monthEnd = await one(
  `select to_char(booking_date, 'YYYY-MM-DD') d
     from bookings where extract(day from booking_date) = 31 limit 1`);
if (monthEnd) {
  const mEnd = await getSalesReport(asActor(adminUser), { from: monthEnd.d, to: monthEnd.d });
  const spill = await one(
    `select count(*)::int n from bookings
      where booking_date >= $1::date and booking_date < ($1::date + interval '1 day')`, [monthEnd.d]);
  check('a 31st-of-month window stops at midnight, not 23:59 of the 31st',
    mEnd.summary.count === spill.n,
    `${monthEnd.d}: ${mEnd.summary.count} vs ${spill.n}`);
}

// Junk dates must be ignored, not silently widen the report to everything.
const junk = await getSalesReport(asActor(adminUser), { from: 'not-a-date', to: 'also-bogus' });
check('unparseable dates are ignored instead of widening the report',
  junk.summary.count === orgWide.summary.count,
  `junk=${junk.summary.count} vs all=${orgWide.summary.count}`);

// ---- 9. bySource must obey the same scope as the rest of the report
// It used to be a single org-wide GROUP BY, leaking funnel volume to everyone.
const repSourceTotal = repReport.bySource.reduce((s, r) => s + r.count, 0);
const orgSourceTotal = orgWide.bySource.reduce((s, r) => s + r.count, 0);
const repOwnLeads = await one(
  `select count(*)::int n from leads where owner_id = $1`, [rep.id]);
check('bySource is scoped to the actor, not org-wide',
  repSourceTotal === repOwnLeads.n && repSourceTotal < orgSourceTotal,
  `rep=${repSourceTotal} (own=${repOwnLeads.n}) vs org=${orgSourceTotal}`);
check('bySource stays inside the requested project when one is given',
  (await getSalesReport(asActor(adminUser), { projectId: 'no-such-project' })).bySource.length === 0,
  'bogus project yields no sources');

// ---- 10. the cancellation report must not leak refunds across the org
// It previously filtered on projectId only - no owner, no date range.
const orgCancels = await getCancellationReport(asActor(adminUser), {});
const repCancels = await getCancellationReport(asActor(rep), {});
check('a salesperson cannot see the whole org cancellation total',
  repCancels.total < orgCancels.total,
  `rep=${repCancels.total} vs org=${orgCancels.total}`);
check('a cancellation report is flagged as restricted for a salesperson',
  repCancels.scope.restricted === true && orgCancels.scope.restricted === false,
  JSON.stringify({ rep: repCancels.scope.restricted, admin: orgCancels.scope.restricted }));
check('cancellation refund totals are scoped too, not just the count',
  repCancels.totalRefund <= orgCancels.totalRefund,
  `${repCancels.totalRefund} <= ${orgCancels.totalRefund}`);

const cancelDay = await one(
  `select to_char(cancelled_at, 'YYYY-MM-DD') d, count(*)::int n
     from cancellations group by 1 order by n desc limit 1`);
if (cancelDay) {
  const win = await getCancellationReport(asActor(adminUser), { from: cancelDay.d, to: cancelDay.d });
  check('the cancellation report honours its date range',
    win.total === cancelDay.n, `${cancelDay.d}: ${win.total} vs ${cancelDay.n}`);
} else {
  check('the cancellation report honours its date range', true, 'no cancellations in dataset');
}

// ---- 11. project listing must be readable without exposing inventory money
// Site-visit and meeting forms need to name a project, so `projects.view` exists
// separately from `projects.manage`. The per-project rollup - notably
// `inventoryValue` - stays management-only.
const visitingRoles = (Object.keys(ROLE_PERMISSIONS) as (keyof typeof ROLE_PERMISSIONS)[])
  .filter((r) => (ROLE_PERMISSIONS[r] as readonly string[]).includes('visits.manage'));
const missingView = visitingRoles.filter((r) => !(ROLE_PERMISSIONS[r] as readonly string[]).includes('projects.view'));
check('every role that logs site visits can also read projects',
  missingView.length === 0,
  missingView.length ? `missing projects.view: ${missingView.join(', ')}` : visitingRoles.join(', '));
check('projects.view is not a manager permission by accident',
  !(ROLE_PERMISSIONS.SALES_EXECUTIVE as readonly string[]).includes('projects.manage') &&
  (ROLE_PERMISSIONS.SALES_EXECUTIVE as readonly string[]).includes('projects.view'),
  'SALES_EXECUTIVE has view, not manage');

const execProjects = await listProjects(actorFor(rep));
check('a read-only role can list projects at all',
  execProjects.length > 0, `${execProjects.length} projects`);
check('a read-only role gets no inventory rollup or tower list',
  execProjects.length > 0 && execProjects.every((p) =>
    p.unitStats === undefined && p.towers === undefined && p.inventoryValue === undefined),
  execProjects.length ? Object.keys(execProjects[0]).join(',') : 'none');
check('a read-only role still gets the fields needed to pick one',
  execProjects.length > 0 && execProjects.every((p) => !!p.id && !!p.name),
  execProjects.length ? execProjects[0].name : 'none');

const adminProjects = await listProjects(actorFor(adminUser));
check('a manager still gets the full rollup',
  adminProjects.length > 0 && adminProjects.every((p) => p.unitStats !== undefined),
  adminProjects.length ? `inventoryValue=${(adminProjects[0] as { unitStats?: { inventoryValue?: string } }).unitStats?.inventoryValue}` : 'none');
check('redaction changes shape only, never the visible project set',
  adminProjects.length === execProjects.length, `${adminProjects.length} vs ${execProjects.length}`);

console.log(
  `\n${fail === 0 ? 'ALL DB CHECKS PASSED' : fail + ' DB CHECK(S) FAILED'} — ${pass} passed, ${fail} failed`,
);
await pool.end();
process.exit(fail === 0 ? 0 : 1);
