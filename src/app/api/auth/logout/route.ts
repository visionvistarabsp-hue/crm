import { withPublic } from '@/lib/handlers';
import { logout } from '@/lib/auth';
import { clearSessionCookie } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Idempotent: signing out with no session, or twice, is not an error. */
export const POST = withPublic(async () => {
  await logout();
  await clearSessionCookie();
  return { ok: true };
});

/** Allow the form-less `GET /api/auth/logout` used by plain <a> links. */
export const GET = POST;
