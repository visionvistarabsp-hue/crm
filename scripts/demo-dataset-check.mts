/**
 * Offline sanity check for the demo dataset: builds the pure dataset twice and
 * asserts the invariants that the database seed depends on. No DB required.
 *
 *   npx tsx scripts/demo-dataset-check.mts
 */
import { generateDataset } from '../src/lib/db/seed-generate';
import { CONSTRAINTS } from '../src/lib/db/constraints';

const NOW = new Date('2026-02-15T09:00:00.000Z');
const a = generateDataset({ seed: 20260215, now: NOW });
const b = generateDataset({ seed: 20260215, now: NOW });

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const isPhone = (v: unknown) => typeof v === 'string' && /^\+91 \d{10}$/.test(v);
const ids = (rows: Array<Record<string, unknown>>) => new Set(rows.map((r) => r.id as string));

// ---- determinism (dates excluded: they are intentionally wall-clock relative)
const shape = (d: typeof a) =>
  JSON.stringify(Object.fromEntries(Object.entries(d).map(([k, v]) => [k, Array.isArray(v) ? v.length : v])));
check('deterministic row counts across runs', shape(a) === shape(b));
const sortedJoin = (rows: Array<Record<string, unknown>>, key: string) =>
  rows.map((r) => String(r[key])).sort().join('|');
let sameContent = true;
for (const [k, v] of Object.entries(a)) {
  if (Array.isArray(v) && v.length && typeof v[0] === 'object' && 'name' in (v[0] as object)) {
    if (sortedJoin(v as Array<Record<string, unknown>>, 'name') !== sortedJoin(b[k] as Array<Record<string, unknown>>, 'name')) {
      sameContent = false;
      console.log(`      diverged array: ${k}`);
    }
  }
}
check('deterministic sampled content across runs', sameContent);

// ---- ids unique within every table (`counters`/`settings` are keyed by `key`)
let dupIds = 0;
for (const [k, v] of Object.entries(a)) {
  if (!Array.isArray(v) || !v.length) continue;
  if (k === 'counters' || k === 'settings') {
    const set = new Set((v as Array<Record<string, unknown>>).map((r) => r.key));
    if (set.size !== (v as unknown[]).length) {
      dupIds++;
      console.log(`      duplicate keys in ${k}`);
    }
    continue;
  }
  const set = ids(v as Array<Record<string, unknown>>);
  if (set.size !== (v as unknown[]).length) {
    dupIds++;
    console.log(`      duplicate ids in ${k}`);
  }
}
check('unique ids in every table', dupIds === 0);

// ---- referential integrity
const userIds = ids(a.users);
const projectIds = ids(a.projects);
const towerIds = ids(a.towers);
const unitIds = ids(a.units);
const leadIds = ids(a.leads);
const customerIds = ids(a.customers);
const bookingIds = ids(a.bookings);

const ref = (rows: Array<Record<string, unknown>>, col: string, set: Set<string>, label: string) => {
  const bad = rows.filter((r) => r[col] != null && !set.has(r[col] as string));
  if (bad.length) console.log(`      ${label}.${col}: ${bad.length} dangling`);
  return bad.length === 0;
};

check('users.managerId resolves', a.users.every((u) => ref([u], 'managerId', userIds, 'users')));
check('towers.projectId resolves', a.towers.every((t) => ref([t], 'projectId', projectIds, 'towers')));
check('units.projectId resolves', a.units.every((u) => ref([u], 'projectId', projectIds, 'units')));
check('units.towerId resolves', a.units.every((u) => ref([u], 'towerId', towerIds, 'units')));
check('leads.ownerId resolves', a.leads.every((l) => ref([l], 'ownerId', userIds, 'leads')));
check('leads.projectId resolves', a.leads.every((l) => ref([l], 'projectId', projectIds, 'leads')));
check('customers.leadId resolves', a.customers.every((c) => ref([c], 'leadId', leadIds, 'customers')));
check('bookings.customerId resolves', a.bookings.every((b) => ref([b], 'customerId', customerIds, 'bookings')));
check('bookings.unitId resolves', a.bookings.every((b) => ref([b], 'unitId', unitIds, 'bookings')));
check('payments.bookingId resolves', a.payments.every((p) => ref([p], 'bookingId', bookingIds, 'payments')));
check('followups.leadId resolves', a.followups.every((f) => ref([f], 'leadId', leadIds, 'followups')));
check('leadDuplicates.leadId resolves', a.leadDuplicates.every((d) => ref([d], 'leadId', leadIds, 'leadDuplicates')));
check('leadDuplicates.duplicateOfId resolves', a.leadDuplicates.every((d) => ref([d], 'duplicateOfId', leadIds, 'leadDuplicates')));
check('leadAssignments.toUserId resolves', a.leadAssignments.every((x) => ref([x], 'toUserId', userIds, 'leadAssignments')));
check('documents references resolve', a.documents.every((d) => ref([d], 'customerId', customerIds, 'documents') && ref([d], 'leadId', leadIds, 'documents') && ref([d], 'bookingId', bookingIds, 'documents')));

// ---- unit <-> booking agreement (the bug the alias fix addressed)
const unitById = new Map(a.units.map((u) => [u.id as string, u]));
const cancelledBookingIds = new Set(
  a.bookings.filter((b) => b.status === 'CANCELLED').map((b) => b.id as string),
);
let unitBookingMismatch = 0;
for (const b of a.bookings) {
  if (cancelledBookingIds.has(b.id as string)) continue;
  const u = unitById.get(b.unitId as string);
  if (!u) continue;
  const expected = b.status === 'COMPLETED' ? 'SOLD' : 'BOOKED';
  if (u.status !== expected || u.bookingId !== b.id || u.customerId !== b.customerId) unitBookingMismatch++;
}
check('unit rows mirror their booking', unitBookingMismatch === 0, `${a.bookings.length} bookings, ${cancelledBookingIds.size} cancelled`);

const cancelledUnits = new Set(
  a.bookings.filter((b) => b.status === 'CANCELLED').map((b) => b.unitId as string),
);
let cancelledNotReleased = 0;
for (const b of a.bookings) {
  if (!cancelledBookingIds.has(b.id as string)) continue;
  const u = unitById.get(b.unitId as string);
  if (u && (u.status !== 'AVAILABLE' || u.bookingId !== null)) cancelledNotReleased++;
}
check('cancelled units released back to AVAILABLE', cancelledNotReleased === 0, `${cancelledUnits.size} cancelled units`);

const liveBookings = a.bookings.filter((b) => b.status !== 'CANCELLED');
const soldOrBooked = a.units.filter((u) => u.status === 'SOLD' || u.status === 'BOOKED').length;
check('booked/sold unit count equals live booking count', soldOrBooked === liveBookings.length, `${soldOrBooked} vs ${liveBookings.length}`);

// ---- phones
const leadPhones = a.leads.filter((l) => l.isDuplicate !== true).map((l) => l.phone as string);
check('every lead phone is 10 digits', leadPhones.every(isPhone), `sample ${leadPhones[0] ?? '-'}`);
check('lead phones are unique', new Set(leadPhones).size === leadPhones.length);
check('incoming lead phones are 10 digits', a.incomingLeads.every((r) => isPhone((r.rawPayload as Record<string, unknown>)?.phone)));

// ---- lead numbers + counters agree with services/counters.ts
// `nextNumber` defaults to width 4 and every caller omits an explicit width,
// so the seeded rows must already be in `PREFIX-000N` form.
const leadNos = a.leads.map((l) => l.leadNo as string);
check('lead numbers unique', new Set(leadNos).size === leadNos.length);
check('lead numbers use LD-000N', leadNos.every((n) => /^LD-\d{4}$/.test(n)), leadNos[0] ?? '');
check('bookings use BK-000N', a.bookings.every((b) => /^BK-\d{4}$/.test(b.bookingNo as string)));
check('customers use CU-000N', a.customers.every((c) => /^CU-\d{4}$/.test(c.customerNo as string)));
check('payout batches use PO-000N', a.payoutBatches.every((b) => /^PO-\d{4}$/.test(b.batchNo as string)));
// A new record minted at runtime must not collide with a seeded number.
const minted = (prefix: string, value: number) => `${prefix}-${String(value).padStart(4, '0')}`;
check(
  'next runtime number is unused',
  ![...leadNos, ...a.customers.map((c) => c.customerNo as string), ...a.payoutBatches.map((b) => b.batchNo as string)].includes(
    minted('LD', leadNos.length + 1),
  ),
  `next lead ${minted('LD', leadNos.length + 1)}`,
);
const counter = (k: string) => a.counters.find((c) => c.key === k)?.value;
check('counter lead == lead count', counter('lead') === a.leads.length, `${counter('lead')} vs ${a.leads.length}`);
check('counter customer == customer count', counter('customer') === a.customers.length);
check('counter booking == booking count', counter('booking') === a.bookings.length);
check('counter payout == payout batch count', counter('payout') === a.payoutBatches.length);
check('rr:<source> counters present', a.counters.filter((c) => c.key.startsWith('rr:')).length === 10);

// ---- every generated value satisfies the real CHECK constraints
// The allowed values are parsed straight out of the DDL strings in
// `constraints.ts`, so this can never drift from what the database enforces.
const camelToSnake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
let constraintViolations = 0;
for (const c of CONSTRAINTS) {
  const m = /(\w+)\s+IN\s*\(([^)]*)\)/.exec(c.check);
  if (!m) {
    console.log(`      cannot parse constraint ${c.name}`);
    constraintViolations++;
    continue;
  }
  const column = camelToSnake(m[1]);
  const allowed = new Set(m[2].split(',').map((s) => s.trim().replace(/^'|'$/g, '')));
  const rows = (a as Record<string, Array<Record<string, unknown>>>)[c.table] ?? [];
  const bad = rows.filter((r) => r[column] != null && !allowed.has(String(r[column])));
  if (bad.length) {
    constraintViolations++;
    const seen = [...new Set(bad.map((r) => String(r[column])))];
    console.log(`      ${c.name}: ${bad.length}/${rows.length} rows with ${seen.join(', ')}`);
  }
}
check('all CHECK constraints satisfied', constraintViolations === 0, `${CONSTRAINTS.length} constraints`);

// ---- dates are never in the future where that would be nonsense
let futureBookings = 0;
for (const b of a.bookings) {
  if (new Date(b.bookingDate as string).getTime() > NOW.getTime()) futureBookings++;
}
check('no booking dated in the future', futureBookings === 0, `${a.bookings.length} bookings`);

// ---- due-today demo usability
const dayStart = (d: Date) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
};
const lo = dayStart(NOW);
const hi = lo + 86_400_000;
const isToday = (v: unknown) => {
  const t = new Date(v as string).getTime();
  return Number.isFinite(t) && t >= lo && t < hi;
};
const dueToday = a.followups.filter((f) => isToday(f.scheduledAt) && f.status === 'PENDING');
const meetingsToday = a.meetings.filter((m) => isToday(m.startsAt ?? m.scheduledAt));
check('pending follow-ups due today exist', dueToday.length > 0, `${dueToday.length} pending today / ${a.followups.length} total`);
check('meetings today exist', meetingsToday.length > 0, `${meetingsToday.length} today / ${a.meetings.length} total`);
check('every followup has a parseable scheduledAt', a.followups.every((f) => Number.isFinite(new Date(f.scheduledAt as string).getTime())));
check('no follow-up is due in the past while still PENDING', a.followups.every((f) => f.status !== 'PENDING' || new Date(f.scheduledAt as string).getTime() >= lo - 86_400_000));

// ---- assignment coherence
const finalOwner = new Map<string, string>();
for (const x of a.leadAssignments) {
  if (x.toUserId) finalOwner.set(x.leadId as string, x.toUserId as string);
}
let ownerMismatch = 0;
for (const l of a.leads) {
  const owner = finalOwner.get(l.id as string) ?? null;
  if ((l.ownerId ?? null) !== owner) ownerMismatch++;
}
check('lead.ownerId equals last assignment target', ownerMismatch === 0, `${ownerMismatch} mismatched`);

// ---- settings
check('assignment.config seeded', a.settings.some((s) => s.key === 'assignment.config'));

console.log('\n--- volumes ---');
for (const [k, v] of Object.entries(a.stats)) console.log(`${k.padEnd(22)} ${v}`);
const arrs = Object.entries(a).filter(([, v]) => Array.isArray(v) && v.length) as Array<[string, unknown[]]>;
console.log('\n--- all tables ---');
for (const [k, v] of arrs.sort()) console.log(`${k.padEnd(26)} ${v.length}`);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
