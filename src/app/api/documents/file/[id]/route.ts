import { NextResponse } from 'next/server';
import { withApi } from '@/lib/handlers';
import { getDocumentFile } from '@/lib/services/documents';
import { param } from '@/lib/handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Proxy for local storage: streams the raw file bytes with content-type sniffing.
export const GET = withApi(async (actor, _req, ctx) => {
  const id = await param(ctx, 'id');
  const result = await getDocumentFile(actor, id);
  if (!result) return NextResponse.json({ error: { message: 'Not found' } }, { status: 404 });
  const { doc, buffer } = result;
  const headers: Record<string, string> = {};
  if (doc.mimeType) headers['Content-Type'] = doc.mimeType;
  headers['Content-Disposition'] = `inline; filename="${encodeURIComponent(doc.fileName)}"`;
  return new NextResponse(new Uint8Array(buffer), { status: 200, headers });
});