import { withApi, param } from '@/lib/handlers';
import { getDocumentDownloadUrl, verifyDocument, deleteDocument } from '@/lib/services/documents';
import { requirePermission } from '@/lib/api';
import { readJson } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ?mode=url returns a (signed or proxied) download URL; otherwise returns doc metadata
export const GET = withApi(async (actor, req, ctx) => {
  requirePermission(actor.user, 'documents.manage');
  const id = await param(ctx, 'id');
  if (req.nextUrl.searchParams.get('mode') === 'url') {
    return await getDocumentDownloadUrl(actor, id);
  }
  return { ok: true, id };
});

export const POST = withApi(async (actor, req, ctx) => {
  requirePermission(actor.user, 'documents.manage');
  const body = await readJson(req);
  const doc = await verifyDocument(actor, await param(ctx, 'id'), body);
  return doc ?? { status: 404, error: { message: 'Document not found' } };
});

export const DELETE = withApi(async (actor, _req, ctx) => {
  requirePermission(actor.user, 'documents.manage');
  await deleteDocument(actor, await param(ctx, 'id'));
});