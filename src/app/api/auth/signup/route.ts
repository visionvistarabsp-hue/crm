import { z } from 'zod';
import { withPublic } from '@/lib/handlers';
import { requestMeta } from '@/lib/api';
import { registerAndLogin } from '@/lib/auth';
import { setSessionCookie } from '@/lib/session';
import { MIN_PASSWORD_LENGTH } from '@/lib/password';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  name: z.string().trim().min(2, 'Name is too short').max(120),
  email: z.string().trim().min(1, 'Email is required').max(320),
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
    .max(200),
  // Self-service signups always create a plain sales-executive account. Roles
  // are assigned by an existing admin, never by the person registering.
});

export const POST = withPublic(async (req) => {
  const body = bodySchema.parse(await req.json().catch(() => ({})));

  const { token, maxAgeSeconds, user } = await registerAndLogin(body, requestMeta(req));
  await setSessionCookie(token, maxAgeSeconds);

  return { user };
});
