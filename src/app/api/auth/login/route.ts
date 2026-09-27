import { z } from 'zod';
import { withPublic } from '@/lib/handlers';
import { requestMeta } from '@/lib/api';
import { login } from '@/lib/auth';
import { setSessionCookie } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  email: z.string().min(1, 'Email is required').max(320),
  // Not length-checked here; the hash function does that, and rejecting short
  // passwords on login would leak the signup policy to anonymous callers.
  password: z.string().min(1, 'Password is required').max(200),
});

export const POST = withPublic(async (req) => {
  const body = bodySchema.parse(await req.json().catch(() => ({})));

  const { token, maxAgeSeconds, user } = await login(body.email, body.password, requestMeta(req));
  await setSessionCookie(token, maxAgeSeconds);

  return { user };
});
