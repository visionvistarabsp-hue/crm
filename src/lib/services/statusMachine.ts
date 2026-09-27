import { LEAD_STATUSES, type LeadStatus, CLOSED_STATUSES, OPEN_STATUSES } from '../constants';

export const TERMINAL_STATUSES: LeadStatus[] = ['DEAL_COMPLETED', 'CANCELLED', 'DUPLICATE'];

export function isKnownStatus(s: string): s is LeadStatus {
  return (LEAD_STATUSES as readonly string[]).includes(s);
}

export function isOpenStatus(s: string): boolean {
  return (OPEN_STATUSES as readonly string[]).includes(s);
}

export interface StatusValidationResult {
  ok: boolean;
  reason?: string;
}

/**
 * Pure status transition rules (testable).
 * - Initial assignment (null -> any) is always allowed.
 * - Open -> Open and Open -> Closed allowed.
 * - Terminal -> Terminal only when equal (reopening a closed deal/cancelled
 *   lead requires an admin override, which the service layer enforces).
 */
export function validateStatusChange(from: string | null | undefined, to: string): StatusValidationResult {
  if (!isKnownStatus(to)) {
    return { ok: false, reason: `Unknown status: ${to}` };
  }
  if (!from || !isKnownStatus(from) || from === to) {
    return { ok: true };
  }
  const fromTerminal = TERMINAL_STATUSES.includes(from as LeadStatus);
  if (fromTerminal) {
    return { ok: false, reason: `${from} is a terminal status; reopening requires an admin override` };
  }
  if (!isOpenStatus(from) && !isOpenStatus(to)) {
    return { ok: false, reason: `Invalid transition ${from} -> ${to}` };
  }
  return { ok: true };
}

/** Admin/super-admin may reopen terminal statuses. */
export function canReopen(actorRole: string): boolean {
  return actorRole === 'SUPER_ADMIN' || actorRole === 'ADMIN';
}

export function pipelineWithUnknown(status: string | null | undefined): string {
  if (!status) return 'NEW';
  return status;
}