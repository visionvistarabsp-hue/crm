import { ApiError, type Actor } from '@/lib/api';
import { db } from '@/lib/db';
import { incomingLeads, users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { createLead } from '@/lib/services/leads';
import { isDemoMode, demoUser, type CurrentUser } from '@/lib/auth';
import { ROLE_PERMISSIONS } from '@/lib/constants';

const GRAPH_BASE = 'https://graph.facebook.com/v21.0';
const SYSTEM_USER_ID = 'system-meta-bot';

// ---------------------------------------------------------------------
// Env config
// ---------------------------------------------------------------------
export function metaConfig() {
  return {
    pageToken: process.env.FB_PAGE_ACCESS_TOKEN ?? '',
    verifyToken: process.env.META_LEADS_VERIFY_TOKEN ?? '',
    facebookPageId: process.env.META_FB_PAGE_ID || process.env.FB_PAGE_ID || '',
    instagramAccountId: process.env.IG_BUSINESS_ACCOUNT_ID || '',
  };
}

// ---------------------------------------------------------------------
// Graph API
// ---------------------------------------------------------------------
export async function metaGraphGet<T = unknown>(path: string, params: Record<string, string> = {}): Promise<T> {
  const { pageToken } = metaConfig();
  if (!pageToken) throw new ApiError(503, 'FB_PAGE_ACCESS_TOKEN is not configured');

  const qs = new URLSearchParams({ access_token: pageToken, ...params });
  const res = await fetch(`${GRAPH_BASE}/${path.replace(/^\//, '')}?${qs}`);
  const body: any = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body?.error?.message ?? `Graph API error ${res.status}`;
    throw new ApiError(502, msg);
  }
  return body as T;
}

// ---------------------------------------------------------------------
// Lead field mapping
// ---------------------------------------------------------------------
const FIELD_MAP: Record<string, string> = {
  full_name: 'name',
  name: 'name',
  first_name: 'firstName',
  last_name: 'lastName',
  phone_number: 'phone',
  email: 'email',
  budget: 'budget',
  preferred_locality: 'preferredLocation',
  preferred_location: 'preferredLocation',
  city: 'preferredLocation',
  property_type: 'propertyType',
  requirements: 'requirement',
  message: 'requirement',
};

export interface ParsedMetaLead {
  name: string;
  phone?: string;
  email?: string;
  budget?: string;
  preferredLocation?: string;
  propertyType?: string;
  requirement?: string;
  customFields: Record<string, string>;
}

export function parseMetaFieldData(fieldData: Array<{ name?: string; values?: string[] }>): ParsedMetaLead {
  const out: ParsedMetaLead = { name: '', customFields: {} };
  let firstName = '';
  let lastName = '';

  for (const f of fieldData ?? []) {
    const label = (f.name ?? '').toLowerCase();
    const value = (f.values?.[0] ?? '').trim();
    if (!value) continue;

    const target = FIELD_MAP[label];
    if (target === 'firstName') firstName = value;
    else if (target === 'lastName') lastName = value;
    else if (target === 'name') out.name = value;
    else if (target) (out as any)[target] = value;
    else out.customFields[label] = value;
  }

  if (!out.name) out.name = [firstName, lastName].filter(Boolean).join(' ') || 'Meta Lead';

  if (out.budget) {
    const num = out.budget.replace(/[^\d.]/g, '');
    if (num) out.budget = num;
    else delete out.budget;
  }

  return out;
}

export function resolveSource(pageId: string | undefined): string {
  const cfg = metaConfig();
  if (pageId && cfg.instagramAccountId && pageId === cfg.instagramAccountId) return 'INSTAGRAM';
  if (pageId && cfg.facebookPageId && pageId === cfg.facebookPageId) return 'FACEBOOK';
  return 'FACEBOOK';
}

// ---------------------------------------------------------------------
// Actor for unauthenticated webhook processing
// ---------------------------------------------------------------------
async function webhookActor(): Promise<Actor> {
  let user: CurrentUser;
  if (isDemoMode()) {
    user = demoUser;
  } else {
    // The system user has no login of its own, so it is keyed on a fixed id
    // rather than on an external identity.
    const row = await db.query.users.findFirst({ where: eq(users.id, SYSTEM_USER_ID) });
    if (!row) {
      await db.insert(users).values({
        id: SYSTEM_USER_ID,
        name: 'Meta Leads Bot',
        email: 'meta.leads@salespoint.in',
        role: 'ADMIN',
        isActive: true,
      }).onConflictDoNothing();
    }
    const resolved =
      row ?? (await db.query.users.findFirst({ where: eq(users.id, SYSTEM_USER_ID) }));
    if (!resolved) throw new ApiError(500, 'Failed to resolve system user');
    user = {
      id: resolved.id, name: resolved.name, email: resolved.email,
      role: resolved.role as CurrentUser['role'],
      permissions: [...ROLE_PERMISSIONS.ADMIN], isSuperAdmin: false,
    };
  }
  return { user, ip: null, userAgent: 'meta-webhook', path: '/api/webhooks/meta/leads', method: 'POST' };
}

// ---------------------------------------------------------------------
// Core: process a single leadgen id -> normalized lead
// ---------------------------------------------------------------------
export async function processLeadgen(details: {
  leadgenId: string;
  pageId?: string;
  formId?: string;
  adId?: string;
  adName?: string;
  isTest?: boolean;
}): Promise<{ created: boolean; leadId?: string; reason?: string }> {
  if (details.isTest) {
    await db.insert(incomingLeads).values({ provider: 'META', rawPayload: { note: 'Meta test ping' }, status: 'IGNORED' });
    return { created: false, reason: 'test' };
  }
  if (!details.leadgenId) return { created: false, reason: 'missing leadgen_id' };

  const actor = await webhookActor();
  const [incoming] = await db
    .insert(incomingLeads)
    .values({ provider: 'META', rawPayload: details as unknown as Record<string, unknown>, status: 'RECEIVED' })
    .returning();

  try {
    // fetch full lead data from Graph API
    const lead: any = await metaGraphGet(String(details.leadgenId), {
      fields: 'id,created_time,field_data,ad_id,adset_id,campaign_id,form_id,page_id,is_organic',
    });

    const parsed = parseMetaFieldData(lead?.field_data ?? []);
    const source = resolveSource(String(details.pageId || lead?.page_id || ''));

    const result = await createLead(actor, {
      name: parsed.name,
      phone: parsed.phone,
      whatsapp: parsed.phone,
      email: parsed.email,
      source,
      campaign: details.adName || null,
      adName: details.adName || null,
      budget: parsed.budget,
      preferredLocation: parsed.preferredLocation,
      propertyType: parsed.propertyType,
      requirement: parsed.requirement,
      sourceRef: `meta-${source.toLowerCase()}:${details.leadgenId}`,
      meta: {
        pageId: details.pageId || lead?.page_id || null,
        formId: details.formId || lead?.form_id || null,
        adId: details.adId || lead?.ad_id || null,
        adsetId: lead?.adset_id || null,
        campaignId: lead?.campaign_id || null,
        leadgenId: details.leadgenId,
        createdTime: lead?.created_time || null,
        customFields: parsed.customFields,
      },
    });

    await db
      .update(incomingLeads)
      .set({ status: 'CREATED', leadId: result.lead.id })
      .where(eq(incomingLeads.id, incoming.id));

    return { created: true, leadId: result.lead.id };
  } catch (err) {
    await db
      .update(incomingLeads)
      .set({ status: 'ERROR', error: (err as Error).message })
      .where(eq(incomingLeads.id, incoming.id));
    throw err;
  }
}

// ---------------------------------------------------------------------
// Integration status (used by /api/integrations/meta/status)
// ---------------------------------------------------------------------
export async function getMetaIntegrationStatus() {
  const cfg = metaConfig();
  const report: Record<string, unknown> = {
    configured: Boolean(cfg.pageToken),
    verifyTokenConfigured: Boolean(cfg.verifyToken),
    facebookPageConfigured: Boolean(cfg.facebookPageId),
    instagramConfigured: Boolean(cfg.instagramAccountId),
    checks: [] as Array<{ name: string; ok: boolean; detail: string }>,
  };
  const checks = report.checks as Array<{ name: string; ok: boolean; detail: string }>;

  if (!cfg.pageToken) {
    checks.push({ name: 'page-token', ok: false, detail: 'FB_PAGE_ACCESS_TOKEN empty — generate in Meta dashboard' });
    return report;
  }

  try {
    const me = await metaGraphGet<{ id: string; name?: string }>('me', { fields: 'id,name' });
    report.tokenUser = me;
    checks.push({ name: 'page-token', ok: true, detail: `Valid — token owner: ${me.name ?? me.id}` });
  } catch (e) {
    checks.push({ name: 'page-token', ok: false, detail: (e as Error).message });
    return report;
  }

  if (cfg.verifyToken) checks.push({ name: 'verify-token', ok: true, detail: 'Configured (add in Meta: App → Webhooks → verify)' });
  else checks.push({ name: 'verify-token', ok: false, detail: 'META_LEADS_VERIFY_TOKEN empty' });

  if (cfg.facebookPageId) {
    try {
      const page = await metaGraphGet<{ id: string; name?: string }>(String(cfg.facebookPageId), { fields: 'id,name' });
      checks.push({ name: 'facebook-page', ok: true, detail: `${page.name ?? page.id}` });
    } catch (e) {
      checks.push({ name: 'facebook-page', ok: false, detail: (e as Error).message });
    }
  } else {
    checks.push({ name: 'facebook-page', ok: false, detail: 'META_FB_PAGE_ID empty (auto-detect from webhook still works)' });
  }

  if (cfg.instagramAccountId) {
    try {
      const ig = await metaGraphGet<{ id: string; name?: string }>(String(cfg.instagramAccountId), { fields: 'id,name' });
      checks.push({ name: 'instagram', ok: true, detail: `${ig.name ?? ig.id}` });
    } catch (e) {
      checks.push({ name: 'instagram', ok: false, detail: (e as Error).message });
    }
  } else {
    checks.push({ name: 'instagram', ok: false, detail: 'IG_BUSINESS_ACCOUNT_ID empty (needed to tag IG leads)' });
  }

  return report;
}