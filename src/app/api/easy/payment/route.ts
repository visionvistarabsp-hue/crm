import { readJson, requirePermission } from '@/lib/api';
import { withApi } from '@/lib/handlers';
import { listEasyDues, recordEasyPayment, type EasyPaymentInput } from '@/lib/services/easy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApi(async (actor, req) => {
  requirePermission(actor.user, 'leads.view');
  const includePaid = req.nextUrl.searchParams.get('includePaid') === '1';
  return { items: await listEasyDues(actor, { includePaid }) };
});

export const POST = withApi(async (actor, req) => {
  requirePermission(actor.user, 'payments.record');
  const body = (await readJson(req)) as EasyPaymentInput;
  return recordEasyPayment(actor, body);
});
