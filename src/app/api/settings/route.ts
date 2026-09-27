import { withApi } from '@/lib/handlers';
import { getSetting, setSetting } from '@/lib/settings';
import { requirePermission } from '@/lib/api';
import { readJson } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApi(async (actor, req) => {
  requirePermission(actor.user, 'settings.manage');
  const key = req.nextUrl.searchParams.get('key');
  if (key) return { key, value: await getSetting(key, null) };
  return { items: await getSetting('__all__', {}) };
});

export const POST = withApi(async (actor, req) => {
  requirePermission(actor.user, 'settings.manage');
  const body: any = await readJson(req);
  if (!body?.key) return { status: 400, error: { message: 'key required' } };
  await setSetting(body.key, body.value);
  return { ok: true };
});