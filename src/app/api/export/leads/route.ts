import { withApi } from '@/lib/handlers';
import { db } from '@/lib/db';
import { and, inArray, or, ilike } from 'drizzle-orm';
import { leads } from '@/lib/db/schema';
import { NextResponse } from 'next/server';
import { resolveVisibleUserIds } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApi(async (actor, req) => {
  const ownerIds = await resolveVisibleUserIds(actor.user);
  const q = req.nextUrl.searchParams.get('q');
  const search = q ? or(ilike(leads.name, `%${q}%`), ilike(leads.phone, `%${q}%`), ilike(leads.email, `%${q}%`), ilike(leads.leadNo, `%${q}%`)) : undefined;

  const conds: import('drizzle-orm').SQL[] = [];
  if (ownerIds) conds.push(inArray(leads.ownerId, ownerIds));
  if (search) conds.push(search as import('drizzle-orm').SQL);
  const rows = await db.select().from(leads).where(conds.length ? and(...conds) : undefined);

  const esc = (v: unknown) => (v == null ? '' : String(v).replace(/"/g, '""'));
  const csv = [
    'leadNo,name,phone,email,source,status,priority,budget,requirement,createdAt',
    ...rows.map((r) => [r.leadNo, r.name, r.phone, r.email, r.source, r.status, r.priority, r.budget, r.requirement, r.createdAt.toISOString()].map(esc).join(',')),
  ].join('\n');
  return new NextResponse(csv, { status: 200, headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="leads.csv"' } });
});