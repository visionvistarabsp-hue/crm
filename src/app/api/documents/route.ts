import { withApi } from '@/lib/handlers';
import { listDocuments, uploadDocument } from '@/lib/services/documents';
import { requirePermission, pagination } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export const GET = withApi(async (actor, req) => {
  requirePermission(actor.user, 'documents.manage');
  const sp = req.nextUrl.searchParams;
  const { page, pageSize } = pagination(sp);
  const result = await listDocuments(actor, {
    customerId: sp.get('customerId') ?? undefined,
    bookingId: sp.get('bookingId') ?? undefined,
    leadId: sp.get('leadId') ?? undefined,
    status: sp.get('status') ?? undefined,
    documentType: sp.get('type') ?? undefined,
    page,
    pageSize,
  });
  return { ...result, page, pageSize };
});

export const POST = withApi(async (actor, req) => {
  requirePermission(actor.user, 'documents.manage');
  const form = await req.formData();
  const file = form.get('file');
  const title = form.get('title');
  const customerId = form.get('customerId');
  const bookingId = form.get('bookingId');
  const leadId = form.get('leadId');
  const documentType = form.get('documentType');
  if (!(file instanceof File)) return { status: 400, error: { message: 'file (FormData) is required' } };
  const doc = await uploadDocument(actor, {
    file: {
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      buffer: Buffer.from(await file.arrayBuffer()),
    },
    title: title ? String(title) : undefined,
    customerId: customerId ? String(customerId) : null,
    bookingId: bookingId ? String(bookingId) : null,
    leadId: leadId ? String(leadId) : null,
    documentType: documentType ? String(documentType) : undefined,
  });
  return { doc, ok: true };
});