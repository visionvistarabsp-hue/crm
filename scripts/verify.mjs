#!/usr/bin/env node
// One-shot CRM verification against a running dev/prod server.
// Usage: npm run verify  (server must be up, e.g. localhost:3000)
//
// Signs in as VERIFY_EMAIL / VERIFY_PASSWORD, replays the session cookie
// across every check, then confirms the session is destroyed on logout.

const BASE = process.env.VERIFY_BASE || 'http://localhost:3000';
const EMAIL = process.env.VERIFY_EMAIL || 'crm@gmail.com';
const PASSWORD = process.env.VERIFY_PASSWORD || 'crm123';
// Signup mutates the database, so it only runs when explicitly requested.
const RUN_SIGNUP = process.env.VERIFY_SIGNUP === '1';

const apiEndpoints = [
  ['/api/health', 200],
  ['/api/leads', 200],
  ['/api/customers', 200],
  ['/api/bookings', 200],
  ['/api/projects', 200],
  ['/api/units?pageSize=3', 200],
  ['/api/commissions/dashboard', 200],
  ['/api/commissions/rules', 200],
  ['/api/payouts', 200],
  ['/api/followups?scope=today', 200],
  ['/api/meetings', 200],
  ['/api/notifications', 200],
  ['/api/reports/sales?from=2026-01-01&to=2026-12-31', 200],
];

const pages = [
  ['/', 'SalesPoint'],
  ['/leads', 'Leads'],
  ['/customers', 'Customers'],
  ['/bookings', 'Bookings'],
  ['/projects', 'Projects'],
  ['/commissions', 'Commissions'],
  ['/payouts', 'Payouts'],
  ['/reports', 'Reports'],
  ['/followups', 'Follow-ups'],
  ['/followups/new', 'Schedule follow-up'],
  ['/meetings', 'Meetings'],
  ['/meetings/new', 'Schedule meeting'],
  ['/team', 'Team'],
  ['/integrations', 'Integrations'],
];

// Minimal cookie jar: this is a single-origin script, so a name->value map is
// enough and avoids depending on a cookie library.
const jar = new Map();

function storeCookies(res) {
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  for (const entry of raw) {
    const [pair] = entry.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}

function cookieHeader() {
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function call(path, { auth = true, redirect = 'manual', method = 'GET', body } = {}) {
  const headers = {};
  const cookie = cookieHeader();
  if (auth && cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect,
  });
  storeCookies(res);
  return res;
}

const results = [];
let fail = 0;
const pass = (msg) => results.push(msg);
const bad = (msg) => { fail++; results.push(msg); };

async function checkAuthNegative() {
  // A protected endpoint must reject a request with no session cookie.
  const r = await call('/api/leads', { auth: false });
  if (r.status === 401) pass('AUTH 401 OK   /api/leads without session (expected)');
  else bad(`AUTH ${r.status} FAIL /api/leads without session, want 401`);
}

async function checkLogin() {
  const r = await call('/api/auth/login', {
    auth: false, method: 'POST', body: { email: EMAIL, password: PASSWORD },
  });
  if (r.status !== 200) {
    const body = await r.text();
    bad(`AUTH ${r.status} FAIL login as ${EMAIL}: ${body.slice(0, 120)}`);
    return false;
  }
  if (!jar.has('sp_session')) {
    bad('AUTH FAIL    login did not set the sp_session cookie');
    return false;
  }
  pass(`AUTH 200 OK   login as ${EMAIL} (sp_session set)`);

  const me = await call('/api/auth/me');
  if (me.status === 200) {
    const j = await me.json();
    const who = j?.user?.email ?? JSON.stringify(j).slice(0, 80);
    pass(`AUTH 200 OK   /api/auth/me -> ${who}`);
    if (j?.user?.email && j.user.email.toLowerCase() !== EMAIL.toLowerCase()) {
      bad(`AUTH FAIL    session identity ${j.user.email} != ${EMAIL}`);
    }
  } else {
    bad(`AUTH ${me.status} FAIL /api/auth/me after login`);
  }
  return true;
}

async function checkBadPassword() {
  // A wrong password must be rejected, and must not replace the live session.
  const goodToken = jar.get('sp_session');
  const r = await call('/api/auth/login', {
    auth: false, method: 'POST', body: { email: EMAIL, password: 'definitely-wrong-password' },
  });
  if (r.status === 401) pass('AUTH 401 OK   wrong password rejected (expected)');
  else bad(`AUTH ${r.status} FAIL wrong password, want 401`);
  if (jar.get('sp_session') !== goodToken) {
    bad('AUTH FAIL    wrong password overwrote the sp_session cookie');
  }
}

async function checkApi() {
  for (const [ep, want] of apiEndpoints) {
    try {
      const r = await call(ep);
      if (r.status !== want) { bad(`API ${r.status} FAIL ${ep} (want ${want})`); continue; }
      const j = await r.json();
      const n = Array.isArray(j) ? j.length : typeof j.total === 'number' ? j.total : j.items?.length ?? 0;
      pass(`API ${r.status} OK   ${ep}  (${n} rows)`);
    } catch (e) {
      bad(`API NETERR   ${ep}  ${e.message.slice(0, 60)}`);
    }
  }
}

async function checkPages() {
  for (const [p, marker] of pages) {
    try {
      const r = await call(p);
      const t = await r.text();
      const ok = r.status === 200 && !t.includes('Internal Server Error');
      const hasMarker = ok ? t.includes(marker) : false;
      if (!ok || !hasMarker) { bad(`PAGE ${r.status} ${hasMarker ? '' : '(marker miss) '}${p}`); continue; }
      pass(`PAGE ${r.status} OK   ${p}`);
    } catch (e) {
      bad(`PAGE NETERR   ${p}  ${e.message.slice(0, 60)}`);
    }
  }
}

async function checkSignup() {
  if (!RUN_SIGNUP) return;
  const email = `verify-${Date.now()}@salespoint.in`;
  const r = await call('/api/auth/signup', {
    auth: false, method: 'POST',
    body: { name: 'Verify Bot', email, password: 'Verify@1234', confirmPassword: 'Verify@1234' },
  });
  if (r.status === 200) pass(`AUTH 200 OK   signup ${email}`);
  else bad(`AUTH ${r.status} FAIL signup ${email}: ${(await r.text()).slice(0, 120)}`);

  // A weak password must be refused by policy, with a field-level error the
  // form can render (422 VALIDATION, matching every other API route).
  const weak = await call('/api/auth/signup', {
    auth: false, method: 'POST',
    body: { name: 'Weak Bot', email: `weak-${Date.now()}@salespoint.in`, password: 'abc', confirmPassword: 'abc' },
  });
  const weakBody = await weak.text();
  if (weak.status === 422) {
    const code = JSON.parse(weakBody)?.error?.code;
    if (code === 'VALIDATION') pass('AUTH 422 OK   weak password rejected (expected)');
    else bad(`AUTH 422 FAIL weak password missing VALIDATION code, got ${code}`);
  } else {
    bad(`AUTH ${weak.status} FAIL weak password, want 422: ${weakBody.slice(0, 120)}`);
  }

  // Long enough but missing a digit: zod passes this, so it must be the
  // password policy that rejects it.
  const noDigit = await call('/api/auth/signup', {
    auth: false, method: 'POST',
    body: { name: 'No Digit', email: `nodigit-${Date.now()}@salespoint.in`, password: 'abcdefgh', confirmPassword: 'abcdefgh' },
  });
  const noDigitBody = await noDigit.json().catch(() => ({}));
  if (noDigit.status === 422 && noDigitBody?.error?.code === 'WEAK_PASSWORD') {
    pass('AUTH 422 OK   letters-only password rejected (expected)');
  } else {
    bad(`AUTH ${noDigit.status} FAIL letters-only password, want 422 WEAK_PASSWORD, got ${noDigitBody?.error?.code}`);
  }

  // Logging in as the new user must work.
  const li = await call('/api/auth/login', {
    auth: false, method: 'POST', body: { email, password: 'Verify@1234' },
  });
  if (li.status === 200) pass(`AUTH 200 OK   login as newly signed-up ${email}`);
  else bad(`AUTH ${li.status} FAIL login as new signup user`);
}

async function checkLogout() {
  // Keep the exact token so we can replay it after logout: that is the only
  // way to prove the server-side session row was destroyed, not just cleared
  // in the browser.
  const token = jar.get('sp_session');
  const r = await call('/api/auth/logout', { method: 'POST' });
  if (r.status !== 200) bad(`AUTH ${r.status} FAIL logout`);
  else pass('AUTH 200 OK   logout');

  if (jar.get('sp_session')) {
    bad('AUTH FAIL    logout did not clear the sp_session cookie');
  }

  const r2 = await fetch(BASE + '/api/leads', { headers: { cookie: `sp_session=${token}` } });
  if (r2.status === 401) pass('AUTH 401 OK   replayed token rejected after logout (expected)');
  else bad(`AUTH ${r2.status} FAIL replayed token still valid after logout, want 401`);
}

async function main() {
  console.log(`Verifying ${BASE} as ${EMAIL}\n`);

  await checkAuthNegative();
  const loggedIn = await checkLogin();
  await checkBadPassword();

  if (!loggedIn) {
    console.log(results.join('\n'));
    console.log(`FAILURES: ${fail}`);
    console.log('\nLogin failed - skipping authenticated checks.');
    console.log('Create the bootstrap admin first:  npm run db:ensure-admin');
    process.exit(1);
  }

  await checkApi();
  await checkPages();
  await checkSignup();
  await checkLogout();

  const total = apiEndpoints.length + pages.length;
  console.log(results.join('\n'));
  console.log(fail === 0 ? `ALL OK (${total}+ checks)` : `FAILURES: ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
