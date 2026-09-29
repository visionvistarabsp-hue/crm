import { and, asc, eq, inArray, isNull, lt } from 'drizzle-orm';
import { db } from './db';
import { leads, users } from './db/schema';
import { notifyUser } from './notifications';
import { enqueueJobOnceDetailed } from './queue';

/**
 * Real-time lead alerting.
 *
 * Two deliberately independent paths:
 *
 *   A. `notifyOwnerOfNewLead` fires the moment a lead exists, so the assigned
 *      owner learns about it while it is still warm.
 *   B. `scanUnclaimedLeads` runs off the existing cron and escalates to the
 *      owner's manager if nobody engaged the lead in time.
 *
 * They are independent so that one failing does not disable the other: a
 * Resend outage still leaves the in-app notification delivered, and a dead
 * cron still leaves the owner alert sent. Neither is allowed to block or roll
 * back the lead itself - see the call site in `createLead`.
 */

/** How long an owner has to touch a lead before their manager is paged. */
export const ESCALATION_MINUTES = 30;

/** Not a notification type; `notifications.type` is free-form text in the app. */
const NOTIFY_TYPE = 'LEAD_RECEIVED';

interface AlertRecipient {
  id: string;
  email: string;
  name: string;
  newLeadAlertsEnabled: boolean;
  managerId: string | null;
}

interface LeadForAlert {
  id: string;
  leadNo: string;
  name: string;
  phone: string | null;
  email: string | null;
  source: string;
  isDuplicate: boolean;
}

const RECIPIENT_COLUMNS = {
  id: true,
  email: true,
  name: true,
  newLeadAlertsEnabled: true,
  managerId: true,
} as const;

function loadRecipient(userId: string): Promise<AlertRecipient | null> {
  return db.query.users
    .findFirst({ where: eq(users.id, userId), columns: RECIPIENT_COLUMNS })
    .then((u) => u ?? null);
}

/**
 * Walk the reporting line, then fall back to an admin.
 *
 * Only ever returns a recipient who has opted in. Returning `null` therefore
 * means "nobody reachable wants this", which the scan reports as a skip.
 *
 * Two cases are folded in here on purpose. An owner with no `managerId` would
 * otherwise silently never escalate, and the scan reporting it as a skip is the
 * only trace anyone would ever get. A manager who has muted alerts is treated
 * the same way, and the admin fallback catches the lead instead of dropping it
 * on the floor - a page the manager declined is not the same as no page.
 */
async function resolveEscalationTarget(owner: AlertRecipient): Promise<AlertRecipient | null> {
  if (owner.managerId) {
    const manager = await loadRecipient(owner.managerId);
    if (manager?.newLeadAlertsEnabled) return manager;
  }

  // The admin lookup filters on the opt-out in SQL, so anything it returns is
  // already eligible.
  return db.query.users
    .findFirst({
      where: and(
        inArray(users.role, ['ADMIN', 'SUPER_ADMIN']),
        eq(users.isActive, true),
        eq(users.newLeadAlertsEnabled, true),
      ),
      columns: RECIPIENT_COLUMNS,
    })
    .then((u) => u ?? null);
}

function leadSummary(lead: LeadForAlert): string {
  const bits = [
    `Lead: ${lead.name}`,
    `Number: ${lead.leadNo}`,
    lead.phone ? `Phone: ${lead.phone}` : null,
    lead.email ? `Email: ${lead.email}` : null,
    `Source: ${lead.source}`,
    lead.isDuplicate ? 'Note: flagged as a possible duplicate and needs disposing.' : null,
  ];
  return bits.filter((b): b is string => b !== null).join('\n');
}

function alertTitle(lead: LeadForAlert, kind: 'NEW' | 'ESCALATION'): string {
  const base = `New lead: ${lead.name}`;
  return kind === 'NEW' ? base : `${base} — not actioned yet`;
}

/**
 * Outcome of one delivery attempt.
 *
 * `emailFailed` is separated from `skipped` deliberately. `duplicate` means an
 * identical job is already queued, so the page is still owed and the escalation
 * must be kept; `emailFailed` means nothing was queued at all, so the claim has
 * to be released for a later tick to retry. Collapsing the two - which is what
 * `enqueueJobOnce`'s boolean does - turns a provider outage into a lead that is
 * escalated exactly once, silently, into an email that never arrives.
 */
type DeliveryResult = 'delivered' | 'duplicate' | 'emailFailed' | 'optedOut';

async function deliver(
  recipient: AlertRecipient,
  lead: LeadForAlert,
  kind: 'NEW' | 'ESCALATION',
): Promise<DeliveryResult> {
  // The opt-out is honoured per recipient, so a manager who has muted alerts
  // does not get a page for a report they did not ask for. The escalation scan
  // also filters on this during recipient resolution; the check is repeated
  // because it is the whole point of the column and must not depend on the
  // caller having filtered first.
  if (!recipient.newLeadAlertsEnabled) return 'optedOut';

  const title = alertTitle(lead, kind);
  const body = leadSummary(lead);

  // In-app first. `notifyUser` swallows its own errors, and it is the channel
  // that cannot be taken away by a mail provider outage.
  await notifyUser(recipient.id, {
    type: NOTIFY_TYPE,
    title,
    body,
    entityType: 'lead',
    entityId: lead.id,
    meta: { kind, source: lead.source, leadNo: lead.leadNo },
  });

  const outcome = await enqueueJobOnceDetailed(
    'EMAIL',
    {
      to: recipient.email,
      subject: kind === 'NEW' ? `New lead: ${lead.name}` : `Unactioned lead: ${lead.name}`,
      text: body,
    },
    {
      // Exactly-once per lead per channel. A second scan tick, or a retried
      // webhook that replays the same lead, cannot produce a second email.
      digestKey:
        kind === 'NEW' ? `lead-alert:${lead.id}:${recipient.id}` : `lead-escalation:${lead.id}`,
      priority: 2,
      maxAttempts: 3,
    },
  );

  if (outcome.status === 'failed') {
    console.error('[leadAlerts] email enqueue failed', outcome.error);
    return 'emailFailed';
  }
  return outcome.status === 'queued' ? 'delivered' : 'duplicate';
}

/**
 * Page the lead's owner the moment it exists.
 *
 * A no-op when the lead is unassigned: `createLead` runs assignment before
 * this, but a lead created with explicit `ownerId: null` has nobody to page,
 * and inventing a recipient would leak a lead to the wrong person. The
 * escalation scan re-picks the lead up on its next tick if an owner is
 * assigned later.
 */
export async function notifyOwnerOfNewLead(lead: LeadForAlert): Promise<void> {
  // Deliberately no guard on missing phone/email. The alert body is a summary
  // that already handles absent contact lines, and a lead with no captured
  // contact details is exactly the one the owner most needs to chase - not the
  // one to stay quiet about.
  //
  // Re-read the owner rather than trusting `lead.ownerId`: the caller passes
  // the row captured from the create transaction, which predates `assignLead`,
  // so its ownerId is still null. Folding this into the caller instead would be
  // a silent missed-alert bug rather than an error.
  const ownerId = await db.query.leads
    .findFirst({ where: eq(leads.id, lead.id), columns: { ownerId: true } })
    .then((l) => l?.ownerId ?? null);
  if (!ownerId) return;

  const owner = await loadRecipient(ownerId);
  if (!owner) return;

  await deliver(owner, lead, 'NEW');
}

/**
 * Stamp the moment a lead was first engaged by a human.
 *
 * Only ever moves forward: a re-touched or reopened lead must not have its
 * original first-contact time overwritten, or the audit trail of when someone
 * actually picked it up is lost. Best-effort by design - a missing stamp only
 * costs a duplicate escalation, whereas throwing here would fail the user's
 * edit, status change or note.
 */
export async function markLeadTouched(leadId: string): Promise<void> {
  try {
    await db
      .update(leads)
      .set({ firstTouchedAt: new Date() })
      .where(and(eq(leads.id, leadId), isNull(leads.firstTouchedAt)));
  } catch (err) {
    console.error('[leadAlerts] failed to mark lead touched', err);
  }
}

export interface EscalationScanResult {
  /** Leads that reached the threshold and were paged. */
  escalated: number;
  /** Leads already handled, already escalated, or not yet old enough. */
  skipped: number;
  /** Leads past the threshold whose owner has no reachable manager. */
  skippedNoManager: number;
  /** Leads that were paged in-app but whose email could not be enqueued. */
  emailFailures: number;
}

/**
 * Page managers for leads nobody has touched.
 *
 * Runs off the 5-minute cron alongside the reminder scan, so escalation lands
 * 30-35 minutes after arrival depending on cron phase. That is deliberate: a
 * scanner is idempotent and survives restarts, where a per-lead delayed job
 * would need its own expiry handling and a row per lead.
 */
export async function scanUnclaimedLeads(
  reference: Date = new Date(),
): Promise<EscalationScanResult> {
  const result: EscalationScanResult = {
    escalated: 0,
    skipped: 0,
    skippedNoManager: 0,
    emailFailures: 0,
  };
  const cutoff = new Date(reference.getTime() - ESCALATION_MINUTES * 60_000);

  // `lt` on the reference time rather than `runAt` means a lead that arrived
  // while the cron was down is escalated on the first tick back, never before
  // it has genuinely aged 30 minutes.
  const candidates = await db
    .select({
      id: leads.id,
      leadNo: leads.leadNo,
      name: leads.name,
      phone: leads.phone,
      email: leads.email,
      source: leads.source,
      isDuplicate: leads.isDuplicate,
      ownerId: leads.ownerId,
    })
    .from(leads)
    .where(
      and(
        eq(leads.status, 'NEW'),
        isNull(leads.firstTouchedAt),
        isNull(leads.escalatedAt),
        lt(leads.createdAt, cutoff),
      ),
    )
    .orderBy(asc(leads.createdAt))
    .limit(200);

  for (const lead of candidates) {
    if (!lead.ownerId) {
      // No owner means no reporting line to escalate into. Counted separately
      // so a silently-misconfigured team is visible in the cron response
      // rather than looking identical to "everything is handled".
      result.skippedNoManager += 1;
      continue;
    }

    const owner = await loadRecipient(lead.ownerId);
    if (!owner) {
      result.skippedNoManager += 1;
      continue;
    }

    const target = await resolveEscalationTarget(owner);
    if (!target) {
      result.skippedNoManager += 1;
      continue;
    }

    // Claim the row before sending. This conditional update is the real guard
    // against a concurrent tick double-paging, and it re-checks every
    // eligibility predicate the select used - not just the `IS NULL`s. Status
    // is included on purpose: without it, a lead worked on in the gap between
    // the select and this statement would still be claimed and escalated.
    // The age cutoff is deliberately not repeated, because `lt` is already
    // implied by the row having been selected and a re-check only adds a
    // clock-skew dependency.
    const claimed = await db
      .update(leads)
      .set({ escalatedAt: new Date() })
      .where(
        and(
          eq(leads.id, lead.id),
          eq(leads.status, 'NEW'),
          isNull(leads.firstTouchedAt),
          isNull(leads.escalatedAt),
        ),
      )
      .returning({ id: leads.id });

    if (!claimed.length) {
      result.skipped += 1;
      continue;
    }

    let delivery: DeliveryResult;
    try {
      delivery = await deliver(target, lead, 'ESCALATION');
    } catch (err) {
      // Only a genuine fault reaches here - the queue reports insert failure as
      // a result rather than throwing, so the common outage is handled below.
      delivery = 'emailFailed';
      console.error('[leadAlerts] escalation delivery threw', err);
    }

    if (delivery === 'emailFailed') {
      // In-app may already have landed. Roll the claim back so the next tick
      // retries instead of the lead being escalated exactly once, silently,
      // into a missing notification.
      await db
        .update(leads)
        .set({ escalatedAt: null })
        .where(eq(leads.id, lead.id))
        .catch((rollbackErr) =>
          console.error('[leadAlerts] failed to release escalation claim', rollbackErr),
        );
      result.emailFailures += 1;
      continue;
    }

    // `duplicate` counts as escalated: an identical job is already pending, so
    // the page is in flight and the claim must stand to stop a re-page.
    result.escalated += 1;
  }

  return result;
}
