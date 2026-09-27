import { withApi } from '@/lib/handlers';
import { db } from '@/lib/db';
import { notifications } from '@/lib/db/schema';
import { eq, and, isNull, desc, sql } from 'drizzle-orm';
import { pagination } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApi(async (actor, req) => {
  const sp = req.nextUrl.searchParams;
  const { page, pageSize } = pagination(sp);
  const unreadOnly = sp.get('unread') === 'true';
  const where = unreadOnly ? and(eq(notifications.userId, actor.user.id), isNull(notifications.readAt)) : eq(notifications.userId, actor.user.id);
  const [items, rows] = await Promise.all([
    db.select().from(notifications).where(where).orderBy(desc(notifications.createdAt)).limit(pageSize).offset((page - 1) * pageSize),
    db.select({ count: sql<number>`count(*)::int` }).from(notifications).where(where),
  ]);
  return { items, total: Number(rows[0]?.count ?? 0), page, pageSize };
});