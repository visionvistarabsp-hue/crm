#!/usr/bin/env node
// Validate Meta integration credentials from .env (no server needed).
// Usage: node scripts/check-meta.mjs

import { readFileSync, existsSync } from 'node:fs';

const GRAPH = 'https://graph.facebook.com/v21.0';

function readEnv(file = '.env') {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*)"?\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return Object.assign({}, process.env, out);
}

async function graphGet(env, path, fields) {
  const token = env.FB_PAGE_ACCESS_TOKEN;
  const qs = new URLSearchParams({ access_token: token, fields });
  const res = await fetch(`${GRAPH}/${path}?${qs}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  return body;
}

async function main() {
  const env = readEnv();
  const rows = [];
  const token = env.FB_PAGE_ACCESS_TOKEN ?? '';

  rows.push(['FB_PAGE_ACCESS_TOKEN', token ? `set (${token.length} chars)` : 'EMPTY']);
  rows.push(['META_LEADS_VERIFY_TOKEN', env.META_LEADS_VERIFY_TOKEN ? 'set' : 'EMPTY (add to .env + Meta webhook)']);
  rows.push(['META_FB_PAGE_ID', env.META_FB_PAGE_ID || 'EMPTY (optional, auto-detect from webhook)']);
  rows.push(['IG_BUSINESS_ACCOUNT_ID', env.IG_BUSINESS_ACCOUNT_ID || 'EMPTY (needed for IG source tag)']);

  if (!token) {
    rows.forEach((r) => console.log(`${r[0].padEnd(30)} ${r[1]}`));
    console.log('\nSet FB_PAGE_ACCESS_TOKEN first.');
    process.exit(1);
  }

  try {
    const me = await graphGet(env, 'me', 'id,name');
    rows.push(['token-owner', `${me.name ?? me.id}`]);
  } catch (e) {
    rows.push(['token-owner', `INVALID TOKEN: ${e.message}`]);
    process.exit(1);
  }

  if (env.META_FB_PAGE_ID) {
    try {
      const p = await graphGet(env, env.META_FB_PAGE_ID, 'id,name,leadgen_enabled');
      rows.push(['facebook-page', `${p.name ?? p.id} (leadgen_enabled=${p.leadgen_enabled})`]);
    } catch (e) {
      rows.push(['facebook-page', `ERROR: ${e.message}`]);
    }
  }

  if (env.IG_BUSINESS_ACCOUNT_ID) {
    try {
      const ig = await graphGet(env, env.IG_BUSINESS_ACCOUNT_ID, 'id,name,instagram_business_account.fields(name)');
      rows.push(['instagram', `${ig.name ?? ig.id}`]);
    } catch (e) {
      rows.push(['instagram', `ERROR: ${e.message}`]);
    }
  }

  rows.forEach((r) => console.log(`${r[0].padEnd(30)} ${r[1]}`));
}

main().catch((e) => {
  console.error('check-meta failed:', e.message);
  process.exit(1);
});