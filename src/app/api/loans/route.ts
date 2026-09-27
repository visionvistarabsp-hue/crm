import type { NextRequest } from 'next/server';
import { readJson, requirePermission } from '@/lib/api';
import { withApi } from '@/lib/handlers';
import { bookingsNeedingLoan, createLoan, listLoans } from '@/lib/services/loans';
import { loanCreateSchema } from '@/lib/validators';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Loan pipeline, with the stuck loans first. */
export const GET = withApi(async (actor, req: NextRequest) => {
  requirePermission(actor.user, 'loans.view');
  const sp = req.nextUrl.searchParams;
  const stuckOnly = sp.get('stuck') === 'true';
  const result = await listLoans(actor, {
    status: sp.get('status') ?? undefined,
    bankName: sp.get('bank') ?? undefined,
    projectId: sp.get('projectId') ?? undefined,
    bookingId: sp.get('bookingId') ?? undefined,
    stuckOnly,
    limit: sp.get('limit') ? Number(sp.get('limit')) : undefined,
  });
  return { ...result, needsLoan: stuckOnly ? [] : await bookingsNeedingLoan(25) };
});

export const POST = withApi(async (actor, req) => {
  requirePermission(actor.user, 'loans.manage');
  return createLoan(actor, loanCreateSchema.parse(await readJson(req)));
});
