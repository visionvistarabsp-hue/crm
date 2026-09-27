const BASE = 'http://localhost:3000';
const EMAIL = process.env.VERIFY_EMAIL || 'crm@gmail.com';
const PASSWORD = process.env.VERIFY_PASSWORD || 'crm123';

let cookie = '';
const log = [];
const ok = (m) => log.push(`  PASS  ${m}`);
const bad = (m) => log.push(`  FAIL  ${m}`);
const warn = (m) => log.push(`  WARN  ${m}`);

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const kv = c.split(';')[0];
    if (kv.startsWith('sp_session=')) cookie = kv;
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text };
}

const login = await call('/api/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
if (login.status !== 200) { console.log(`LOGIN FAILED ${login.status}`); process.exit(1); }
ok(`login as ${EMAIL}`);

// Pick an active booking that has no plan yet, so re-runs stay idempotent -
// a booking with allocated payments legitimately refuses a replacement plan.
const bl = await call('/api/bookings?pageSize=50');
const items = bl.json?.items ?? [];
if (!items.length) { console.log('no bookings to test against'); process.exit(1); }
const active = items.filter((b) => b.status !== 'CANCELLED' && b.status !== 'CANCELLATION_REQUESTED');

let bk = null;
for (const cand of active) {
  if (Number(cand.saleValue) <= 0) continue;
  const s = await call(`/api/collections/schedule?bookingId=${cand.id}`);
  if (s.status === 200 && (s.json?.milestones?.length ?? 0) === 0) { bk = cand; break; }
}
if (!bk) { console.log('no active booking without a plan to test against'); process.exit(1); }
ok(`using booking ${bk.bookingNo} status=${bk.status} saleValue=${bk.saleValue}`);

// Guard rail: a cancelled booking must refuse a plan.
const cancelled = items.find((b) => b.status === 'CANCELLED');
if (cancelled) {
  const r = await call('/api/collections', {
    method: 'POST',
    body: { bookingId: cancelled.id, milestones: [{ name: 'X', dueDate: '2026-01-01', percentage: 100 }] },
  });
  if (r.status === 422) ok(`cancelled booking ${cancelled.bookingNo} refuses a plan (422)`);
  else bad(`cancelled booking accepted a plan: ${r.status}`);
} else {
  warn('no cancelled booking in the sample to test the guard rail against');
}

// ---- 1. Build an instalment plan
const plan = [
  { name: 'Booking amount', dueDate: '2026-01-15', percentage: 10 },
  { name: 'Agreement registration', dueDate: '2026-04-20', percentage: 30 },
  { name: 'Possession', dueDate: '2026-09-30', percentage: 60 },
];
const setRes = await call('/api/collections', { method: 'POST', body: { bookingId: bk.id, milestones: plan } });
if (setRes.status === 200) {
  const s = setRes.json;
  const expected = Math.round(Number(bk.saleValue));
  const total = Math.round(s.totalPlanned);
  const drift = Math.abs(total - expected);
  ok(`POST schedule milestones=${s.milestones.length} planned=${total} (saleValue ${expected}, drift ${drift})`);
  if (drift > 2) bad(`planned total drifts from sale value by ${drift}`);
  if (s.totalOutstanding !== total) bad(`outstanding should equal planned on a fresh plan`);
  else ok('outstanding equals planned on a fresh plan');
} else bad(`POST schedule ${setRes.status}: ${setRes.text.slice(0, 200)}`);

// ---- 2. Read it back
const sched = await call(`/api/collections/schedule?bookingId=${bk.id}`);
if (sched.status === 200) {
  const m0 = sched.json.milestones[0];
  ok(`GET schedule first milestone "${m0.name}" amount=${m0.amount} status=${m0.status} due=${String(m0.dueDate).slice(0, 10)}`);
  if (sched.json.nextDue) ok(`next due: ${sched.json.nextDue.name} on ${String(sched.json.nextDue.dueDate).slice(0, 10)}`);
  else bad('no next due reported on a fresh plan');
} else bad(`GET schedule ${sched.status}: ${sched.text.slice(0, 200)}`);

// ---- 3. Record a payment pinned to the first milestone
const firstMilestone = sched.json.milestones[0];
const payRes = await call('/api/collections/payment', {
  method: 'POST',
  body: {
    bookingId: bk.id,
    milestoneId: firstMilestone.id,
    amount: 250000,
    method: 'BANK_TRANSFER',
    reference: 'UTR-VERIFY-001',
  },
});
if (payRes.status === 200) {
  const p = payRes.json;
  ok(`POST payment id=${p.paymentId.slice(0, 8)} receiptNo=${p.receiptNo}`);
  if (p.receiptNo) ok('receipt issued automatically with the payment');
  else bad('no receipt was issued with the payment');
  const alloc = p.allocations ?? [];
  if (alloc.length === 1 && Math.abs(alloc[0].amount - 250000) < 1) {
    ok(`pinned allocation applied the full amount to "${alloc[0].name}"`);
  } else bad(`unexpected allocation: ${JSON.stringify(alloc)}`);
  const updated = p.schedule.milestones.find((m) => m.id === firstMilestone.id);
  if (updated.status === 'PARTIAL') ok('milestone moved to PARTIAL after a part payment');
  else bad(`milestone status is ${updated.status}, expected PARTIAL`);
  if (p.schedule.totalReceived >= 250000) ok(`totalReceived now ${p.schedule.totalReceived}`);
  else bad(`totalReceived did not move: ${p.schedule.totalReceived}`);

  // ---- 4. Fetch the printable receipt
  const rec = await call(`/api/collections/receipt/${p.paymentId}`);
  let receiptNo = null;
  if (rec.status === 200) {
    const r = rec.json;
    receiptNo = r.receiptNo;
    ok(`GET receipt ${r.receiptNo} amount=${r.amount} words="${r.amountInWords}"`);
    if (r.customerName) ok(`receipt names the customer: ${r.customerName}`);
    else bad('receipt has no customer name');
    if (r.voided === false) ok('receipt is not voided');
    else bad('receipt came back voided');
  } else bad(`GET receipt ${rec.status}: ${rec.text.slice(0, 200)}`);

  // ---- 5. The printable page itself
  const page = await fetch(`${BASE}/receipts/${p.paymentId}`, { headers: { cookie } });
  const html = await page.text();
  if (page.status === 200 && html.includes('Payment Receipt')) {
    ok(`GET /receipts/[paymentId] renders a printable receipt`);
    if (receiptNo && html.includes(receiptNo)) ok('printable page carries the receipt number');
    else bad('printable page is missing the receipt number');
    if (html.includes('Rupees') && html.includes('Only')) ok('printable page shows the amount in words');
    else bad('printable page is missing the amount in words');
  } else {
    bad(`GET /receipts/${p.paymentId} -> ${page.status}, hasHeading=${html.includes('Payment Receipt')}`);
  }

  // ---- 6. Ageing report reflects the new position
  const rep = await call('/api/collections');
  if (rep.status === 200) {
    const j = rep.json;
    ok(`collections report outstanding=${j.totalOutstanding} overdue=${j.totalOverdue} overdueCount=${j.overdueCount}`);
    const mine = j.overdue.find((o) => o.bookingId === bk.id);
    if (mine) ok(`overdue list includes ${bk.bookingNo} (${mine.name}, ${mine.daysOverdue}d late)`);
    else warn('no overdue row yet - the first milestone is still within terms, which is correct');
    if (j.buckets.length) ok(`ageing buckets: ${j.buckets.map((b) => `${b.label}=${b.amount}`).join(', ')}`);
  } else bad(`GET collections ${rep.status}: ${rep.text.slice(0, 200)}`);
} else bad(`POST payment ${payRes.status}: ${payRes.text.slice(0, 300)}`);

// ---- 7. Loan guard rails
const overValue = await call('/api/loans', {
  method: 'POST',
  body: { bookingId: bk.id, loanType: 'HOME', loanAmount: Number(bk.saleValue) * 2 },
});
if (overValue.status === 422) ok('loan above the sale value is rejected (422)');
else bad(`oversized loan returned ${overValue.status}, expected 422: ${overValue.text.slice(0, 160)}`);

const noDate = await call('/api/loans', {
  method: 'POST',
  body: { bookingId: bk.id, loanType: 'HOME', loanAmount: 1000000 },
});
if (noDate.status === 200) {
  const l = noDate.json;
  ok(`POST loan with no dates accepted (applicationDate defaulted) id=${l.id.slice(0, 8)} status=${l.status}`);
  if (l.financingShare !== null) ok(`financing share computed: ${l.financingShare}%`);
  const sanctions = await call(`/api/loans/${l.id}`, {
    method: 'PATCH',
    body: { status: 'DISBURSED' },
  });
  if (sanctions.status === 422) ok('disbursing without a sanction date is blocked (422)');
  else bad(`disbursement without sanction returned ${sanctions.status}, expected 422`);
  const adv = await call(`/api/loans/${l.id}`, { method: 'PATCH', body: { status: 'DOCUMENTS_PENDING' } });
  if (adv.status === 200) ok(`stage advance works, now ${adv.json.status}`);
  else bad(`stage advance returned ${adv.status}`);
  const byBooking = await call(`/api/loans?bookingId=${bk.id}`);
  if (byBooking.status === 200 && byBooking.json.rows.length >= 1) {
    ok(`loans scoped to booking ${bk.bookingNo}: ${byBooking.json.rows.length}`);
  } else bad(`booking-scoped loans returned ${byBooking.status}/${byBooking.json?.rows?.length}`);
} else bad(`POST loan with no dates ${noDate.status}: ${noDate.text.slice(0, 200)}`);

console.log(log.join('\n'));
const fails = log.filter((l) => l.startsWith('  FAIL'));
console.log(`\n${log.filter((l) => l.startsWith('  PASS')).length} passed, ${fails.length} failed, ${log.filter((l) => l.startsWith('  WARN')).length} warnings`);
console.log(`\nNOTE: a demo schedule and loan were created on booking ${bk.bookingNo} (${bk.customer?.name ?? 'customer'}).`);
