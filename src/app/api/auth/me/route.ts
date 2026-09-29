import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { withApi } from '@/lib/handlers';
import { ApiError } from '@/lib/api';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const preferencesSchema = z.object({
  // Whitelisted field only: this endpoint writes to the signed-in user's own
  // row, so a PATCH body must never become a generic user update surface.
  newLeadAlertsEnabled: z.boolean().optional(),
});

export const GET = withApi(async (actor) => {
  const row = await db.query.users
    .findFirst({ where: eq(users.id, actor.user.id), columns: { newLeadAlertsEnabled: true } })
    .catch(() => null);
  // A null row is a user the session table knows but the users table does not
  // (possible mid-provision). Default to on rather than 500, matching the
  // column default, so the settings page still renders.
  return { user: actor.user, newLeadAlertsEnabled: row?.newLeadAlertsEnabled ?? true };
});

export const PATCH = withApi(async (actor, req) => {
  const body = preferencesSchema.parse(await req.json());
  if (body.newLeadAlertsEnabled === undefined) {
    throw new ApiError(422, 'No supported preference supplied');
  }

  await db
    .update(users)
    .set({ newLeadAlertsEnabled: body.newLeadAlertsEnabled, updatedAt: new Date() })
    .where(eq(users.id, actor.user.id));

  return { newLeadAlertsEnabled: body.newLeadAlertsEnabled };
});
