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

/**
 * Split a handler's return value into a response body and a status code.
 *
 * Handlers may return `{ ...body, status }` to pick a code, but only when the
 * payload is an error envelope. Without this the code was silently discarded and
 * every failure reached the client as a 200, so `res.ok` was true for a 400, a
 * 403 and a 422 alike and callers had to sniff the body to tell them apart.
 *
 * The `error` guard is what keeps this safe: a success payload may legitimately
 * carry a `status` field of its own (a lead's `status: 'NEW'`), and that must
 * stay in the body rather than become the response code.
 */
function respondWith(body: unknown): [unknown, number] {
  if (body === null || typeof body !== 'object') return [body, 200];
  const { status, ...rest } = body as { status?: unknown };
  if (typeof status === 'number' && 'error' in rest) {
    return [rest, status];
  }
  return [body, 200];
}

/** Wrap a route handler with auth + consistent error mapping. */
export function withApi(handler: Handler) {
  return async (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => {
    try {
      const actor = await requireUser(req);
      const body = await handler(actor, req, ctx);
      if (body === undefined) return json({ ok: true });
      return json(...respondWith(body));
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