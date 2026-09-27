import { requirePermission } from '@/lib/api';
import { param, withApi } from '@/lib/handlers';
import { getLoan, updateLoan } from '@/lib/services/loans';
import { loanUpdateSchema } from '@/lib/validators';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApi(async (actor, _req, ctx) => {
  requirePermission(actor.user, 'loans.view');
  return getLoan(actor, await param(ctx, 'id'));
});

/** Advance the loan, or correct any field on it. */
export const PATCH = withApi(async (actor, req, ctx) => {
  requirePermission(actor.user, 'loans.manage');
  const patch = loanUpdateSchema.parse(await req.json());
  return updateLoan(actor, await param(ctx, 'id'), patch);
});
