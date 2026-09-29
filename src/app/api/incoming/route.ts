import { withApi } from '@/lib/handlers';
import { requirePermission } from '@/lib/api';
import { db } from '@/lib/db';
import { incomingLeads } from '@/lib/db/schema';
import { and, count, desc, eq } from 'drizzle-orm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUSES = ['RECEIVED', 'CREATED', 'DUPLICATE', 'ERROR', 'IGNORED'] as const;

/**
 * Operator view over webhook receipts - the reconciliation queue's audit log.
 * Listing is scoped to message processing power (`settings.manage`), not to
 * any one lead: this page exists so an admin can see why a provider delivery
 * never became a lead and hand it back to the queue.
 */
export const GET = withApi(async (actor, req) => {
  requirePermission(actor.user, 'settings.manage');

  const search = req.nextUrl.searchParams;
  const statusParam = search.get('status');
  const status = STATUSES.includes(statusParam as (typeof STATUSES)[number])
    ? (statusParam as (typeof STATUSES)[number])
    : null;
  const provider = search.get('provider')?.trim() || null;
  const limit = Math.min(Math.max(Number(search.get('limit')) || 50, 1), 200);

  const countRows = await db
    .select({ status: incomingLeads.status, count: count() })
    .from(incomingLeads)
    .groupBy(incomingLeads.status);

  const counts = Object.fromEntries(
    STATUSES.map((s) => [s, countRows.find((r) => r.status === s)?.count ?? 0]),
  ) as Record<(typeof STATUSES)[number], number>;

  const filters = and(
    status ? eq(incomingLeads.status, status) : undefined,
    provider ? eq(incomingLeads.provider, provider) : undefined,
  );

  const items = await db
    .select({
      id: incomingLeads.id,
      provider: incomingLeads.provider,
      status: incomingLeads.status,
      leadId: incomingLeads.leadId,
      error: incomingLeads.error,
      receivedAt: incomingLeads.receivedAt,
      rawPayload: incomingLeads.rawPayload,
    })
    .from(incomingLeads)
    .where(filters)
    .orderBy(desc(incomingLeads.receivedAt))
    .limit(limit);

  return { counts, items, filtered: { status, provider, limit } };
});