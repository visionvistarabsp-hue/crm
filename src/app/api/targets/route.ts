import type { NextRequest } from 'next/server';
import { readJson, requirePermission } from '@/lib/api';
import { withApi } from '@/lib/handlers';
import { getTargetReport, setTargetsBulk } from '@/lib/services/targets';
import { monthKey } from '@/lib/services/forecast';
import { targetBulkSchema } from '@/lib/validators';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Achievement + forecast for a period. Defaults to the current month. */
export const GET = withApi(async (actor, req: NextRequest) => {
  requirePermission(actor.user, 'targets.view');
  const sp = req.nextUrl.searchParams;
  const report = await getTargetReport(
    actor,
    sp.get('period') ?? monthKey(new Date()),
    sp.get('projectId') ?? undefined,
  );
  return report;
});

/** Set the whole team's targets for a period in one submit. */
export const POST = withApi(async (actor, req: NextRequest) => {
  requirePermission(actor.user, 'targets.manage');
  const { period, rows } = targetBulkSchema.parse(await readJson(req));
  return setTargetsBulk(actor, period, rows);
});
