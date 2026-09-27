import { NextRequest, NextResponse } from 'next/server';
import { ApiError, json, requireUser } from './api';

type Handler<T = unknown> = (actor: Awaited<ReturnType<typeof requireUser>>, req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<T>;

/**
 * Map a Zod failure to a 422 the UI can show. Duck-typed on `name` rather than
 * `instanceof` so a Zod instance from another bundle still matches.
 * Returns null when the error is not a validation failure.
 */
function zodErrorResponse(err: unknown): NextResponse | null {
  const issues = (err as { issues?: { path?: (string | number)[]; message?: string }[] })?.issues;
  if (!Array.isArray(issues)) return null;
  const first = issues[0];
  const field = first?.path?.join('.') ?? 'field';
  return NextResponse.json(
    { error: { message: `${field}: ${first?.message ?? 'invalid value'}`, code: 'VALIDATION' } },
    { status: 422 },
  );
}

/** Wrap a route handler with auth + consistent error mapping. */
export function withApi(handler: Handler) {
  return async (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => {
    try {
      const actor = await requireUser(req);
      const body = await handler(actor, req, ctx);
      if (body === undefined) return json({ ok: true });
      return json(body);
    } catch (err) {
      if (err instanceof ApiError) {
        return NextResponse.json({ error: { message: err.message, code: err.code } }, { status: err.status });
      }
      const invalid = zodErrorResponse(err);
      if (invalid) return invalid;
      console.error('[api]', req.nextUrl.pathname, err);
      return NextResponse.json({ error: { message: 'Internal server error' } }, { status: 500 });
    }
  };
}

/** Public route (no auth, e.g. webhooks, health, login/signup). */
export function withPublic(handler: (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<NextResponse | object>) {
  return async (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => {
    try {
      const out = await handler(req, ctx);
      if (out instanceof NextResponse) return out;
      return json(out);
    } catch (err) {
      if (err instanceof ApiError) {
        return NextResponse.json({ error: { message: err.message, code: err.code } }, { status: err.status });
      }
      // Without this a bad request body surfaced as 500 instead of a
      // field-level validation error the form can display.
      const invalid = zodErrorResponse(err);
      if (invalid) return invalid;
      console.error('[api:public]', req.nextUrl.pathname, err);
      return NextResponse.json({ error: { message: 'Internal server error' } }, { status: 500 });
    }
  };
}

/** Resolve a single path param (correct next 15 async params handling). */
export async function param(ctx: { params: Promise<Record<string, string>> }, key: string): Promise<string> {
  const p = await ctx.params;
  return p?.[key] ?? '';
}