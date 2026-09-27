import type { NextRequest } from 'next/server';
import { readJson, requirePermission } from '@/lib/api';
import { withApi } from '@/lib/handlers';
import { getCollectionsReport, setSchedule } from '@/lib/services/collections';
import { milestonePlanSchema } from '@/lib/validators';

/** Receivables ageing across every open milestone the actor can see. */
export const GET = withApi(async (actor, req: NextRequest) => {
  requirePermission(actor.user, 'collections.view');
  const sp = req.nextUrl.searchParams;
  return getCollectionsReport(actor, {
    projectId: sp.get('projectId') ?? undefined,
    salesPersonId: sp.get('salespersonId') ?? undefined,
  });
});

/** Replace a booking's instalment plan. */
export const POST = withApi(async (actor, req: NextRequest) => {
  requirePermission(actor.user, 'collections.manage');
  const { bookingId, milestones } = milestonePlanSchema.parse(await readJson(req));
  return setSchedule(actor, bookingId, milestones);
});
