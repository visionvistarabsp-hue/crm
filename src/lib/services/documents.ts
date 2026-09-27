import { db } from '../db';
import { desc, eq, and, sql } from 'drizzle-orm';
import type { Actor } from '../api';
import { ApiError } from '../api';
import { documents } from '../db/schema';
import { getStorage, hashFile } from '../storage';
import { documentVerifySchema } from '../validators';
import { writeAudit } from '../audit';
import { sanitizeKey } from '../storage';

export type DocumentRow = typeof documents.$inferSelect;

export interface DocumentUploadInput {
  file: { name: string; mimeType: string; size: number; buffer: Buffer };
  customerId?: string | null;
  bookingId?: string | null;
  leadId?: string | null;
  documentType?: string;
  title?: string;
}

/**
 * Upload a document: writes bytes to the configured storage backend (R2
 * when configured, otherwise the local disk fallback) and stores metadata.
 */
export async function uploadDocument(actor: Actor, input: DocumentUploadInput): Promise<DocumentRow> {
  const storage = getStorage();
  if (input.file.size <= 0) throw new ApiError(422, 'Empty file');
  if (input.file.size > 50 * 1024 * 1024) throw new ApiError(413, 'File exceeds 50 MB');

  const key = `${actor.user.id}/${Date.now()}-${sanitizeKey(input.file.name)}`;
  await storage.put(key, input.file.buffer, input.file.mimeType);
  const sha256 = hashFile(input.file.buffer);

  const [doc] = await db
    .insert(documents)
    .values({
      customerId: input.customerId ?? null,
      bookingId: input.bookingId ?? null,
      leadId: input.leadId ?? null,
      documentType: input.documentType ?? 'OTHER',
      title: input.title ?? input.file.name,
      fileName: input.file.name,
      r2Key: key,
      mimeType: input.file.mimeType,
      size: input.file.size,
      sha256,
      verificationStatus: 'PENDING',
      uploadedById: actor.user.id,
    })
    .returning();

  await writeAudit({ actor, action: 'CREATE', entity: 'document', entityId: doc.id, newValue: { type: doc.documentType, fileName: doc.fileName } });
  return doc;
}

export async function listDocuments(actor: Actor, filters: { customerId?: string; bookingId?: string; leadId?: string; status?: string; documentType?: string; page?: number; pageSize?: number } = {}) {
  const conds: any[] = [];
  if (filters.customerId) conds.push(eq(documents.customerId, filters.customerId));
  if (filters.bookingId) conds.push(eq(documents.bookingId, filters.bookingId));
  if (filters.leadId) conds.push(eq(documents.leadId, filters.leadId));
  if (filters.status) conds.push(eq(documents.verificationStatus, filters.status));
  if (filters.documentType) conds.push(eq(documents.documentType, filters.documentType));
  const where = conds.length ? and(...conds) : undefined;

const [items, [{ count }]] = await Promise.all([
    db.query.documents.findMany({ where, orderBy: [desc(documents.createdAt)], limit: filters.pageSize ?? 50, offset: ((filters.page ?? 1) - 1) * (filters.pageSize ?? 50) }),
    db.select({ count: sql<number>`count(*)::int` }).from(documents).where(where ?? sql`true`),
  ]);
  return { items, total: count };
}

/** Signed/expiring download URL, or the authenticated proxy URL for local storage. */
export async function getDocumentDownloadUrl(actor: Actor, id: string): Promise<{ url: string; expiresIn: number }> {
  const doc = await db.query.documents.findFirst({ where: eq(documents.id, id) });
  if (!doc) throw new ApiError(404, 'Document not found');
  const storage = getStorage();
  const signed = await storage.getSignedUrl(doc.r2Key, 3600);
  if (signed) return { url: signed, expiresIn: 3600 };
  return { url: `/api/documents/file/${id}`, expiresIn: 0 };
}

/** Raw bytes for the proxy route (local storage only). */
export async function getDocumentFile(actor: Actor, id: string): Promise<{ doc: DocumentRow; buffer: Buffer } | null> {
  const doc = await db.query.documents.findFirst({ where: eq(documents.id, id) });
  if (!doc) return null;
  const storage = getStorage();
  const buffer = await storage.get(doc.r2Key);
  if (!buffer) return null;
  return { doc, buffer };
}

export async function verifyDocument(actor: Actor, id: string, rawData: unknown): Promise<DocumentRow | null> {
  const data = documentVerifySchema.parse(rawData);
  const existing = await db.query.documents.findFirst({ where: eq(documents.id, id) });
  if (!existing) throw new ApiError(404, 'Document not found');
  const [updated] = await db
    .update(documents)
    .set({
      verificationStatus: data.verificationStatus,
      verificationNote: data.verificationNote ?? null,
      verifiedById: actor.user.id,
      verifiedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(documents.id, id))
    .returning();
  await writeAudit({ actor, action: 'UPDATE', entity: 'document', entityId: id, oldValue: { verificationStatus: existing.verificationStatus }, newValue: { verificationStatus: data.verificationStatus } });
  return updated ?? null;
}

export async function deleteDocument(actor: Actor, id: string): Promise<void> {
  const doc = await db.query.documents.findFirst({ where: eq(documents.id, id) });
  if (!doc) throw new ApiError(404, 'Document not found');
  try {
    await getStorage().delete(doc.r2Key);
  } catch {
    /* ignore storage errors on delete */
  }
  await db.delete(documents).where(eq(documents.id, id));
  await writeAudit({ actor, action: 'DELETE', entity: 'document', entityId: id });
}