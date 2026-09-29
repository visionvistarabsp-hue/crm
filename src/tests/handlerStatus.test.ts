import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextResponse, NextRequest } from 'next/server';
import { withApi } from '@/lib/handlers';

/**
 * `withApi` must turn a handler's `{ error, status }` return value into that
 * status code. Before this, the code was dropped and every failure reached the
 * client as a 200 - so `res.ok` was true for a 400, a 403 and a 422 alike, and
 * callers had to sniff the body to tell them apart. Three routes rely on it.
 *
 * The `error` guard matters just as much: a success payload may legitimately
 * carry a `status` field of its own, and turning `status: 'NEW'` into a
 * response code would corrupt the data.
 */

function callWith<T>(handlerBody: unknown): Promise<{ status: number; body: any }> {
  const handler = withApi((async () => handlerBody) as any);
  // A real NextRequest, so the error-logging path can read req.nextUrl.
  const req = new NextRequest('https://example.test/api/x', { method: 'GET' });
  return (handler as any)(req, { params: Promise.resolve({}) }).then((res: NextResponse) =>
    res.json().then((body: any) => ({ status: res.status, body })),
  );
}

// withApi runs requireUser before the handler, which short-circuits to the
// synthetic demo actor under this flag. Lets the real auth path run.
beforeAll(() => {
  process.env.AUTH_DEMO_MODE = 'true';
});
afterAll(() => {
  delete process.env.AUTH_DEMO_MODE;
});

describe('withApi response codes', () => {
  it('honours the status on an error envelope', async () => {
    expect((await callWith({ error: { message: 'Invalid webhook secret' }, status: 403 })).status).toBe(403);
    expect((await callWith({ status: 400, error: { message: 'key required' } })).status).toBe(400);
    expect((await callWith({ error: { message: 'name: Required' }, status: 422 })).status).toBe(422);
  });

  it('keeps the error message and drops the status field from the body', async () => {
    const res = await callWith({ error: { message: 'Invalid webhook secret' }, status: 403 });
    expect(res.body).toEqual({ error: { message: 'Invalid webhook secret' } });
  });

  it('does not turn a success payload status field into a response code', async () => {
    // A lead payload carries `status: 'NEW'`; it is data, not an HTTP code.
    const lead = { id: 'lead-1', name: 'Riya', status: 'NEW' };
    const res = await callWith(lead);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(lead);
  });

  it('ignores a non-numeric status field', async () => {
    const res = await callWith({ ok: true, status: 'DUPLICATE' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'DUPLICATE' });
  });

  it('defaults an undefined body to 200 ok', async () => {
    const res = await callWith(undefined);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
