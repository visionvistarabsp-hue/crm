import { withApi, param } from '@/lib/handlers';
import { db } from '@/lib/db';
import { notifications } from '@/lib/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { readJson } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withApi(async (actor, req, ctx) => {
  const body: any = await readJson(req);
  const id = await param(ctx, 'id');
  if (id === 'all') {
    await db.update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.userId, actor.user.id), isNull(notifications.readAt)));
  } else {
    await db.update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.id, id), eq(notifications.userId, actor.user.id)));
  }
  return { ok: true };
});