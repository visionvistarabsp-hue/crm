import { db } from './db';
import { auditLogs } from './db/schema';
import type { Actor } from './api';
import type { CurrentUser } from './auth';
import { isDemoMode } from './auth';

export interface AuditEntry {
  user?: CurrentUser | null;
  actor?: Actor | null;
  action: string;
  entity: string;
  entityId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  meta?: Record<string, unknown>;
}

/**
 * Write an immutable audit trail entry. Best-effort: never throws.
 */
export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    const actor = entry.actor;
    const user = actor?.user ?? entry.user ?? null;
    await db.insert(auditLogs).values({
      userId: user?.id ?? null,
      userEmail: user?.email ?? null,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId ?? null,
      oldValue: entry.oldValue ?? null,
      newValue: entry.newValue ?? null,
      ip: actor?.ip ?? null,
      userAgent: actor?.userAgent ?? null,
      requestPath: actor?.path ?? null,
      requestMethod: actor?.method ?? null,
      meta: entry.meta ?? {},
    });
  } catch {
    /* audit must never break a request */
  }
}

export { isDemoMode };