import { ApiError, type Actor } from '@/lib/api';
import { db } from '@/lib/db';
import { incomingLeads, integrations, users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { createLead } from '@/lib/services/leads';
import { matchProjectForLead } from '@/lib/services/projectMatch';
import { isDemoMode, demoUser, type CurrentUser } from '@/lib/auth';
import { ROLE_PERMISSIONS } from '@/lib/constants';
import { decryptSecret, looksEncrypted } from '@/lib/secrets';

const GRAPH_BASE = 'https://graph.facebook.com/v21.0';
const SYSTEM_USER_ID = 'system-meta-bot';

// ---------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------
export interface MetaConfig {
  pageToken: string;
  verifyToken: string;
  /**
   * App secret used to verify `X-Hub-Signature-256` on inbound lead events.
   * Empty means the webhook cannot authenticate anything, so callers must
   * reject rather than fall through.
   */
  appSecret: string;
  facebookPageId: string;
  instagramAccountId: string;
  /** Meta form id -> lead source, so one webhook can feed several funnels. */
  formSources: Record<string, string>;
}

export function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function readStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const id = key.trim();
    const source = text(raw);
    if (id && source) out[id] = source.toUpperCase();
  }
  return out;
}

function envConfig(): MetaConfig {
  return {
    pageToken: process.env.FB_PAGE_ACCESS_TOKEN?.trim() ?? '',
    verifyToken: process.env.META_LEADS_VERIFY_TOKEN?.trim() ?? '',
    appSecret: process.env.META_APP_SECRET?.trim() ?? '',
    facebookPageId: text(process.env.META_FB_PAGE_ID) || text(process.env.FB_PAGE_ID),
    instagramAccountId: text(process.env.IG_BUSINESS_ACCOUNT_ID),
    formSources: readStringMap(process.env.META_FORM_SOURCES),
  };
}

/**
 * An enabled `integrations` row wins so an admin can rotate Meta credentials
 * from the settings UI without a redeploy. The environment is only the fallback
 * for deployments that configure the provider purely through env vars, and a
 * decrypt failure degrades to that fallback rather than throwing.
 */
export async function metaConfig(): Promise<MetaConfig> {
  let row: typeof integrations.$inferSelect | undefined;
  try {
    row = await db.query.integrations.findFirst({ where: eq(integrations.provider, 'meta') });
  } catch {
    row = undefined;
  }

  const env = envConfig();
  if (!row?.isActive) return env;

  const config = (row.config ?? {}) as Record<string, unknown>;
  const secret = (key: string): string => {
    const stored = text(config[key]);
    if (!stored) return '';
    if (!looksEncrypted(stored)) return stored;
    try {
      return decryptSecret(stored);
    } catch {
      return '';
    }
  };

  return {
    pageToken: secret('pageToken') || env.pageToken,
    verifyToken: secret('verifyToken') || env.verifyToken,
    appSecret: secret('appSecret') || env.appSecret,
    facebookPageId: text(config.facebookPageId) || env.facebookPageId,
    instagramAccountId: text(config.instagramAccountId) || env.instagramAccountId,
    formSources: { ...env.formSources, ...readStringMap(config.formSources) },
  };
}

// ---------------------------------------------------------------------
// Graph API
// ---------------------------------------------------------------------
export async function metaGraphGet<T = unknown>(path: string, params: Record<string, string> = {}): Promise<T> {
  const { pageToken } = await metaConfig();
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
  // Lets a campaign name the inventory the ad is for, which beats inference.
  project_code: 'project',
  project: 'project',
  preferred_project: 'project',
};

export interface ParsedMetaLead {
  name: string;
  phone?: string;
  email?: string;
  budget?: string;
  preferredLocation?: string;
  propertyType?: string;
  requirement?: string;
  project?: string;
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

/**
 * Meta's leadgen payload does not carry a channel, so the channel is inferred
 * from which identity the form is bound to. An explicit form mapping beats the
 * page/account comparison, and an unmapped form falls back to Facebook, which
 * is what a Lead Ads form resolves to on its own.
 */
export async function resolveSource(
  pageId: string | undefined,
  formId?: string,
  customFields?: Record<string, string>,
): Promise<string> {
  return classifySource(await metaConfig(), { pageId, formId, customFields });
}

/**
 * Pure source classifier, split out so the fallback ladder can be tested
 * without a database round trip.
 */
export function classifySource(
  cfg: MetaConfig,
  lead: { pageId?: string; formId?: string; customFields?: Record<string, string> },
): string {
  // A hidden field on the form is the most explicit signal a customer can give.
  if (lead.customFields?.whatsapp_account_id?.trim()) return 'WHATSAPP';

  const mapped = lead.formId ? cfg.formSources[text(lead.formId)] : undefined;
  if (mapped) return mapped;

  if (lead.pageId && cfg.instagramAccountId && lead.pageId === cfg.instagramAccountId) return 'INSTAGRAM';
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
}): Promise<{ created: boolean; leadId?: string; reason?: string; duplicate?: boolean }> {
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
    const resolvedPageId = String(details.pageId || lead?.page_id || '');
    const resolvedFormId = String(details.formId || lead?.form_id || '');
    const source = await resolveSource(resolvedPageId, resolvedFormId, parsed.customFields);

    // A named project on the form is authoritative; otherwise infer from the
    // location and requirement the customer typed.
    const projectMatch = await matchProjectForLead({
      preferredLocation: parsed.preferredLocation,
      requirement: parsed.requirement,
      propertyType: parsed.propertyType,
      budget: parsed.budget,
      explicitProject: parsed.project,
    });

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
      projectId: projectMatch?.projectId,
      sourceRef: `meta-${source.toLowerCase()}:${details.leadgenId}`,
      meta: {
        pageId: details.pageId || lead?.page_id || null,
        formId: details.formId || lead?.form_id || null,
        sourceResolution: source,
        projectMatch: projectMatch
          ? {
              projectId: projectMatch.projectId,
              projectName: projectMatch.projectName,
              projectCode: projectMatch.projectCode,
              confidence: projectMatch.confidence,
              score: projectMatch.score,
              reason: projectMatch.reason,
            }
          : null,
        adId: details.adId || lead?.ad_id || null,
        adsetId: lead?.adset_id || null,
        campaignId: lead?.campaign_id || null,
        leadgenId: details.leadgenId,
        createdTime: lead?.created_time || null,
        customFields: parsed.customFields,
      },
    });

    if (!result.created) {
      // Redelivery of a lead we already have. The receipt row is kept (it is
      // the audit trail of this delivery) but marked DUPLICATE rather than
      // CREATED, so the reconciliation scan can tell a genuine new lead apart
      // from a retry and nobody gets alerted or assigned twice.
      await db
        .update(incomingLeads)
        .set({
          status: 'DUPLICATE',
          leadId: result.lead.id,
          normalized: { leadgenId: details.leadgenId, sourceRef: `meta-${source.toLowerCase()}:${details.leadgenId}` },
        })
        .where(eq(incomingLeads.id, incoming.id));
      return { created: false, duplicate: true, leadId: result.lead.id };
    }

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
  const cfg = await metaConfig();
  const report: Record<string, unknown> = {
    configured: Boolean(cfg.pageToken),
    verifyTokenConfigured: Boolean(cfg.verifyToken),
    appSecretConfigured: Boolean(cfg.appSecret),
    facebookPageConfigured: Boolean(cfg.facebookPageId),
    instagramConfigured: Boolean(cfg.instagramAccountId),
    formSourceMappings: cfg.formSources,
    checks: [] as Array<{ name: string; ok: boolean; detail: string }>,
  };
  const checks = report.checks as Array<{ name: string; ok: boolean; detail: string }>;

  // Reported before the page-token early return: inbound events are rejected
  // outright without a secret, so this is the most likely reason a live webhook
  // is delivering nothing even while the page token looks healthy.
  checks.push({
    name: 'app-secret',
    ok: Boolean(cfg.appSecret),
    detail: cfg.appSecret
      ? 'Configured — inbound lead events are signature-verified'
      : 'META_APP_SECRET empty — every POST is rejected with 503',
  });

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

  checks.push({
    name: 'form-sources',
    ok: Object.keys(cfg.formSources).length > 0,
    detail:
      Object.keys(cfg.formSources).length > 0
        ? `${Object.keys(cfg.formSources).length} form(s) mapped to a channel`
        : 'No form mappings — every Meta lead is tagged Facebook unless it carries a whatsapp_account_id field',
  });

  return report;
}