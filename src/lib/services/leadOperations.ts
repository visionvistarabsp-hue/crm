import { db } from '@/lib/db';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { ApiError, Actor } from '@/lib/api';
import {
  leads,
  followups,
  meetings,
  bookings,
  payments,
  documents,
  leadActivities,
  leadStatusHistory,
} from '@/lib/db/schema';
import { canAccessLead } from './leads';
import { listOutboundMessages } from '@/lib/messageLog';
import { __testables } from './customerHistory';

const { toNumber, iso, filterPayments } = __testables;

/**
 * LeadOpsKind is the lead-specific variant of the shared TimelineKind.
 * It deliberately stays local so the customer 360 timeline is untouched.
 */
export type LeadOpsKind =
  | 'FOLLOWUP'
  | 'SITE_VISIT'
  | 'MEETING'
  | 'BOOKING'
  | 'PAYMENT'
  | 'DOCUMENT'
  | 'STATUS_CHANGE'
  | 'NOTE'
  | 'MESSAGE'
  | 'ACTIVITY';

export interface LeadOpsEntry {
  id: string;
  kind: LeadOpsKind;
  title: string;
  detail: string | null;
  at: string;
  amount: number | null;
  status: string | null;
  refId: string;
  actorName: string | null;
}

export interface LeadOperationsView {
  lead: { id: string; leadNo: string; name: string; status: string };
  summary: {
    nextFollowup: { id: string; scheduledAt: string; status: string } | null;
    overdueCount: number;
    visits: { completed: number; nextScheduledAt: string | null };
    booking: { id: string; bookingNo: string; status: string } | null;
    agreement: { id: string; title: string | null; fileName: string; verificationStatus: string } | null;
    amountCollected: number;
  };
  timeline: LeadOpsEntry[];
}

/**
 * Auto-penned `lead_activities` rows whose real source lives in a dedicated
 * table (which already contributes its own timeline event) are skipped so a
 * single action never shows twice in the feed.
 */
const DUPLICATE_ACTIVITY_TYPES = new Set([
  'FOLLOWUP_CREATED',
  'SITE_VISIT',
  'MEETING',
  'BOOKING',
  'PAYMENT',
  'CANCELLATION',
  'STATUS_CHANGE',
]);

const AGREEMENT_TYPES = ['AGREEMENT', 'BOOKING_FORM'] as const;
const VISIT_TYPES = ['SCHEDULED', 'CONFIRMED', 'RESCHEDULED'] as const;

interface Draft {
  id: string;
  kind: LeadOpsKind;
  title: string;
  detail: string | null;
  at: Date | string | null;
  amount: number | null;
  status: string | null;
  refId: string;
  actorName: string | null;
}

/** Local mirror of customerHistory's buildTimeline: ISO-first, newest first, stable. */
function buildTimeline(events: Draft[]): LeadOpsEntry[] {
  const timed: LeadOpsEntry[] = [];
  for (const e of events) {
    const at = iso(e.at);
    if (!at) continue;
    timed.push({ ...e, at });
  }
  timed.sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? 1 : -1));
  return timed;
}

export async function getLeadOperations(actor: Actor, id: string): Promise<LeadOperationsView> {
  const canAccess = await canAccessLead(actor, id);
  if (!canAccess) throw new ApiError(404, 'Lead not found');

  const leadRow = await db.query.leads.findFirst({
    where: eq(leads.id, id),
    columns: { id: true, leadNo: true, name: true, status: true },
  });
  if (!leadRow) throw new ApiError(404, 'Lead not found');

  const [fups, meets, bks, docs, acts, hist] = await Promise.all([
    db.query.followups.findMany({ where: eq(followups.leadId, id), orderBy: [asc(followups.scheduledAt)] }),
    db.query.meetings.findMany({ where: eq(meetings.leadId, id), orderBy: [asc(meetings.scheduledAt)] }),
    db.query.bookings.findMany({ where: eq(bookings.leadId, id), orderBy: [desc(bookings.bookingDate)] }),
    db.query.documents.findMany({
      where: and(eq(documents.leadId, id), inArray(documents.documentType, [...AGREEMENT_TYPES])),
      orderBy: [desc(documents.createdAt)],
    }),
    db.query.leadActivities.findMany({ where: eq(leadActivities.leadId, id), orderBy: [desc(leadActivities.createdAt)] }),
    db.query.leadStatusHistory.findMany({ where: eq(leadStatusHistory.leadId, id), orderBy: [desc(leadStatusHistory.createdAt)] }),
  ]);

  const bookingIds = bks.map((b) => b.id);
  const pays = bookingIds.length
    ? await db.query.payments.findMany({ where: inArray(payments.bookingId, bookingIds), orderBy: [desc(payments.paymentDate)] })
    : [];

  const msgLog = await listOutboundMessages({ leadId: id });

  const now = Date.now();

  // ---- summary tiles -------------------------------------------------------
  const upcoming = fups
    .filter((f) => f.status === 'PENDING' && f.scheduledAt && f.scheduledAt.getTime() >= now)
    .sort((a, b) => a.scheduledAt!.getTime() - b.scheduledAt!.getTime());
  const nextFollowup = upcoming[0] ?? null;
  const overdue = fups.filter((f) => f.status === 'PENDING' && f.scheduledAt && f.scheduledAt.getTime() < now).length;

  const siteVisits = meets.filter((m) => m.type === 'SITE_VISIT');
  const completedVisits = siteVisits.filter((m) => m.status === 'COMPLETED').length;
  const scheduledVisits = siteVisits
    .filter((m) => m.status && (VISIT_TYPES as readonly string[]).includes(m.status))
    .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
  const nextVisit = scheduledVisits[0] ?? null;

  const activeBookings = bks.filter((b) => b.status !== 'CANCELLED').sort((a, b) => b.bookingDate.getTime() - a.bookingDate.getTime());
  const booking = activeBookings[0] ?? null;
  const agreements = docs
    .filter((d) => d.documentType === 'AGREEMENT')
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const agreement = agreements[0] ?? null;

  const settled = filterPayments(pays);
  const amountCollected = settled.reduce((sum, p) => sum + toNumber(p.amount), 0);

  // ---- timeline ------------------------------------------------------------
  const drafts: Draft[] = [];

  for (const f of fups) {
    drafts.push({
      id: f.id,
      kind: 'FOLLOWUP',
      title: `Follow-up (${f.type ?? 'CALL'})`,
      detail: f.notes ?? null,
      at: f.scheduledAt,
      amount: null,
      status: f.status,
      refId: f.id,
      actorName: null,
    });
  }

  for (const m of meets) {
    drafts.push({
      id: m.id,
      kind: m.type === 'SITE_VISIT' ? 'SITE_VISIT' : 'MEETING',
      title: m.type === 'SITE_VISIT' ? (m.visitNumber ? `Site visit #${m.visitNumber}` : 'Site visit') : (m.title ?? 'Meeting'),
      detail: [m.location, m.notes].filter((s): s is string => Boolean(s)).join(' · ') || null,
      at: m.scheduledAt,
      amount: null,
      status: m.status,
      refId: m.id,
      actorName: null,
    });
  }

  for (const b of bks) {
    drafts.push({
      id: b.id,
      kind: 'BOOKING',
      title: `Booking ${b.bookingNo}`,
      detail: b.notes ?? null,
      at: b.bookingDate,
      amount: toNumber(b.saleValue),
      status: b.status,
      refId: b.id,
      actorName: null,
    });
  }

  for (const p of settled) {
    drafts.push({
      id: p.id,
      kind: 'PAYMENT',
      title: 'Payment received',
      detail: p.reference ?? null,
      at: p.paymentDate,
      amount: toNumber(p.amount),
      status: p.status,
      refId: p.id,
      actorName: null,
    });
  }

  for (const d of docs) {
    drafts.push({
      id: d.id,
      kind: 'DOCUMENT',
      title: d.title ?? d.fileName,
      detail: `Verification: ${d.verificationStatus}`,
      at: d.createdAt,
      amount: null,
      status: d.verificationStatus,
      refId: d.id,
      actorName: null,
    });
  }

  for (const h of hist) {
    drafts.push({
      id: h.id,
      kind: 'STATUS_CHANGE',
      title: 'Status changed',
      detail: `${h.fromStatus ?? '-'} \u2192 ${h.toStatus}`,
      at: h.createdAt,
      amount: null,
      status: h.toStatus,
      refId: h.id,
      actorName: null,
    });
  }

  for (const a of acts) {
    if (DUPLICATE_ACTIVITY_TYPES.has(a.type)) continue;
    drafts.push({
      id: a.id,
      kind: a.type === 'NOTE' ? 'NOTE' : 'ACTIVITY',
      title: a.note ?? a.type,
      detail: null,
      at: a.createdAt,
      amount: null,
      status: a.type,
      refId: a.id,
      actorName: null,
    });
  }

  for (const m of msgLog.items ?? []) {
    drafts.push({
      id: m.id,
      kind: 'MESSAGE',
      title: `${m.channel} ${m.status === 'FAILED' ? 'failed' : 'sent'}`,
      detail: [m.subject, m.recipient].filter((s): s is string => Boolean(s)).join(' · ') || null,
      at: m.createdAt,
      amount: null,
      status: m.status,
      refId: m.id,
      actorName: m.userName ?? null,
    });
  }

  return {
    lead: {
      id: leadRow.id,
      leadNo: leadRow.leadNo ?? '—',
      name: leadRow.name,
      status: leadRow.status,
    },
    summary: {
      nextFollowup: nextFollowup ? { id: nextFollowup.id, scheduledAt: iso(nextFollowup.scheduledAt)!, status: nextFollowup.status } : null,
      overdueCount: overdue,
      visits: { completed: completedVisits, nextScheduledAt: nextVisit ? iso(nextVisit.scheduledAt) : null },
      booking: booking ? { id: booking.id, bookingNo: booking.bookingNo, status: booking.status } : null,
      agreement: agreement
        ? { id: agreement.id, title: agreement.title ?? null, fileName: agreement.fileName, verificationStatus: agreement.verificationStatus }
        : null,
      amountCollected,
    },
    timeline: buildTimeline(drafts),
  };
}