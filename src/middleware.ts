import { NextResponse, type NextRequest } from 'next/server';

/**
 * Edge guard. It runs before every request, on every path, so it must stay free
 * of Node-only APIs and must not touch the database — `pg` and `node:crypto`
 * scrypt are unavailable here.
 *
 * All it does is check that a session cookie is *present*. That is enough to
 * send signed-out visitors to the login screen, and it deliberately is not
 * treated as proof of identity: every page and API route re-validates the
 * token against the database via `getCurrentUser()` in the Node runtime. An
 * expired or revoked cookie therefore gets as far as the render, and is then
 * rejected (or redirected) by the real check.
 */

const SESSION_COOKIE = 'sp_session';

/** Paths reachable without a session cookie. */
const PUBLIC_PREFIXES = [
  '/login',
  '/signup',
  '/api/auth/login',
  '/api/auth/signup',
  '/api/auth/logout',
  '/api/auth/me',
  '/api/auth/session',
  '/api/health',
  '/api/webhooks',
  // Cron-only. The route itself enforces CRON_SECRET and fails closed, so
  // letting it past the edge guard is safe - the guard has no header check.
  '/api/internal/process-queue',
];

/** Prefixes Next.js serves itself. */
const ASSET_PREFIXES = ['/_next', '/favicon', '/icon', '/images', '/fonts', '/robots.txt', '/sitemap.xml'];

const DEMO_MODE = process.env.AUTH_DEMO_MODE === 'true';

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

function isAsset(pathname: string): boolean {
  return ASSET_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (isAsset(pathname)) return NextResponse.next();
  if (pathname.startsWith('/api/') && isPublic(pathname)) return NextResponse.next();
  if (!pathname.startsWith('/api/') && isPublic(pathname)) {
    // Signed-in users have no reason to see the login or signup screen.
    if (req.cookies.has(SESSION_COOKIE)) {
      return NextResponse.redirect(new URL('/', req.url));
    }
    return NextResponse.next();
  }

  if (DEMO_MODE) return NextResponse.next();

  if (req.cookies.has(SESSION_COOKIE)) return NextResponse.next();

  // No cookie. API callers get a JSON 401; browsers get the login screen with
  // a `next` param so they land back where they were headed.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { error: { message: 'Authentication required', code: 'UNAUTHENTICATED' } },
      { status: 401 },
    );
  }

  const loginUrl = new URL('/login', req.url);
  if (pathname !== '/') loginUrl.searchParams.set('next', pathname + req.nextUrl.search);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    /*
     * Everything except Next internals and files with an extension, which keeps
     * the guard off static assets without maintaining a static list.
     */
    '/((?!_next/static|_next/image).*)',
  ],
};
