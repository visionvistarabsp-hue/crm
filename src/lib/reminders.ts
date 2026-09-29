import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { db } from './db';
import { backgroundJobs, customers, followups, leads, paymentDue, users } from './db/schema';
import { enqueueJobOnce, registerJobHandler, type JobHandler } from './queue';
import { isValidEmail, resolveEmailConfig, sendEmail } from './resend';
import { getSetting } from './settings';

const DEFAULT_TIME_ZONE = 'Asia/Kolkata';
const DEFAULT_REMINDER_HOUR = 9;
const DEFAULT_REMINDER_MINUTE = 0;
/**
 * How often each agent hears from us while work is still open. Two slots per
 * local day, pinned to the agent's own reminder time, so the interval is
 * exactly 12h apart instead of drifting with cron restarts.
 */
export const DIGEST_INTERVAL_HOURS = 12;
/**
 * A payment is "pending" from the moment it is scheduled, not from the moment
 * it goes overdue, so the agent can act before the date passes rather than
 * after. Three days is the approved window: it is long enough to chase a
 * customer through a weekend, and short enough that the twice-daily digest
 * stays a short list instead of a standing reminder of everything on the
 * horizon.
 */
export const PAYMENT_LOOKAHEAD_DAYS = 3;

/**
 * Upper bound on how far ahead a follow-up's own `remindBeforeMinutes` can pull
 * it into the digest. A row configured with an absurd lead time (a bad import,
 * a typo of 100000) would otherwise pull the entire backlog into every email.
 */
export const MAX_FOLLOWUP_LEAD_MINUTES = 1440;

/** Default lead time for a follow-up that never set `remindBeforeMinutes`. */
const DEFAULT_FOLLOWUP_LEAD_MINUTES = 60;

/**
 * Instant from which a follow-up should surface, given the moment it is
 * scheduled and the lead time configured on the row. The window is clamped to
 * [0, MAX_FOLLOWUP_LEAD_MINUTES] so a negative or absurd value degrades to
 * something sane instead of hiding the follow-up forever or flooding the digest.
 */
export function followupVisibleFrom(scheduledAt: Date, remindBeforeMinutes: number | null | undefined): Date {
  // `Number(null)` is 0, so a null lead has to be rejected before the numeric
  // path or an unset row would be treated as "no advance warning" instead of
  // getting the default hour.
  const raw = remindBeforeMinutes == null ? Number.NaN : Number(remindBeforeMinutes);
  const lead = Number.isFinite(raw)
    ? Math.min(Math.max(Math.trunc(raw), 0), MAX_FOLLOWUP_LEAD_MINUTES)
    : DEFAULT_FOLLOWUP_LEAD_MINUTES;
  return new Date(scheduledAt.getTime() - lead * 60_000);
}
/**
 * An agent with a long backlog would otherwise get an unbounded email that
 * mail providers truncate mid-list. The section header still reports the true
 * count, so the number never understates the work.
 */
const MAX_ITEMS_PER_SECTION = 20;
/**
 * `status` says a payment was never marked settled, but a stale or
 * hand-edited `PARTIAL` row can still carry a `paidAmount` at or above the
 * amount. Chasing those would tell the agent to demand money that is already
 * in, so the row-level outstanding check is the real gate and the status check
 * is only a cheap pre-filter.
 */
export function hasOutstandingDue(amount: number | string, paidAmount: number | string | null | undefined): boolean {
  const due = toNumber(amount);
  if (due === null) return false;
  // An unparseable paid amount is treated as nothing paid, which is the safe
  // direction: the row stays in the digest rather than being silently dropped.
  return due - (toNumber(paidAmount) ?? 0) > 0;
}

const OUTSTANDING_SQL = sql`${paymentDue.amount} - COALESCE(${paymentDue.paidAmount}, 0) > 0`;

export interface ReminderItem {
  kind: 'FOLLOWUP' | 'PAYMENT';
  refId: string;
  party: string;
  contact: string | null;
  when: Date;
  detail: string;
  /** False for work that is scheduled but not yet late. */
  overdue?: boolean;
}

export interface ScanResult {
  dueItems: number;
  agentsNotified: number;
  skippedAlreadyQueued: number;
  skippedOptedOut: number;
  skippedInactive: number;
  skippedNoEmail: number;
  emailConfigured: boolean;
}

interface EmailJobPayload {
  to: string;
  subject: string;
  text: string;
  agentId?: string;
}

export function appTimeZone(): string {
  const tz = process.env.APP_TIMEZONE?.trim();
  if (!tz) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/**
 * Timezone for the digest schedule, resolved DB-first so a new instance can be
 * set from the Settings UI (`app.timezone`); falls back to APP_TIMEZONE / the
 * default when nothing is saved.
 */
export async function resolveAppTimeZone(): Promise<string> {
  const saved = (await getSetting<string>('app.timezone', '')).trim();
  if (!saved) return appTimeZone();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: saved });
    return saved;
  } catch {
    return appTimeZone();
  }
}

function tzOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const part of dtf.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - date.getTime();
}

/** Instant at which the wall clock reads `hour:minute` in `timeZone` on the local day of `reference`. */
export function zonedWallClock(reference: Date, timeZone: string, hour: number, minute: number): Date {
  const offset = tzOffsetMs(reference, timeZone);
  const local = new Date(reference.getTime() + offset);
  const target = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
    hour,
    minute,
    0,
    0,
  );
  let result = new Date(target - offset);
  const corrected = tzOffsetMs(result, timeZone);
  if (corrected !== offset) result = new Date(target - corrected);
  return result;
}

export function endOfLocalDay(reference: Date, timeZone: string): Date {
  return new Date(zonedWallClock(reference, timeZone, 23, 59).getTime() + 59_999);
}

/** Calendar day of `reference` as seen in `timeZone`, as `YYYY-MM-DD`. */
export function localDateKey(reference: Date, timeZone: string): string {
  const local = new Date(reference.getTime() + tzOffsetMs(reference, timeZone));
  return local.toISOString().slice(0, 10);
}

function parseReminderTime(value: string | null | undefined): { hour: number; minute: number } {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec((value ?? '').trim());
  if (!match) return { hour: DEFAULT_REMINDER_HOUR, minute: DEFAULT_REMINDER_MINUTE };
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * The two local wall-clock times an agent should be pinged at, derived from
 * their configured reminder time. Both land on the same local day and sit
 * exactly `DIGEST_INTERVAL_HOURS` apart, so a 18:00 agent gets 08:00 and
 * 18:00 rather than 18:00 and a stray 06:00 that belongs to tomorrow.
 */
export function digestSlots(hour: number, minute: number): { hour: number; minute: number }[] {
  const second = new Date(Date.UTC(2000, 0, 1, hour + DIGEST_INTERVAL_HOURS, minute, 0, 0));
  const slots = [
    { hour, minute },
    { hour: second.getUTCHours(), minute: second.getUTCMinutes() },
  ];
  slots.sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
  return slots;
}

interface Formatters {
  date(value: Date): string;
  time(value: Date): string;
  money(value: number): string;
}

function formatters(timeZone: string): Formatters {
  return {
    date: (value) =>
      new Intl.DateTimeFormat('en-IN', { timeZone, day: '2-digit', month: 'short', year: 'numeric' }).format(value),
    time: (value) =>
      new Intl.DateTimeFormat('en-IN', { timeZone, hour: '2-digit', minute: '2-digit', hour12: true }).format(value),
    money: (value) =>
      new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
        maximumFractionDigits: 0,
      }).format(value),
  };
}

/**
 * Postgres `numeric` arrives as a string in drizzle, so every amount has to be
 * coerced before arithmetic. Returns null for anything that is not a finite
 * number, which callers treat as "nothing worth chasing".
 */
function toNumber(value: number | string | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A partially paid due is still outstanding, so the digest must name what is
 * left rather than repeat the original amount as if nothing had landed. Fully
 * settled dues are filtered out by the query, so this only ever renders a
 * remaining balance.
 */
export function outstandingLabel(
  money: (value: number) => string,
  amount: number,
  paidAmount: number,
): string {
  const total = Number.isFinite(amount) ? amount : 0;
  const settled = Number.isFinite(paidAmount) ? paidAmount : 0;
  const outstanding = Math.max(0, total - settled);
  if (settled <= 0) return money(total);
  if (outstanding <= 0) return money(0);
  return `${money(outstanding)} left of ${money(total)}`;
}

export function buildReminderDigest(input: {
  agentName: string;
  followups: ReminderItem[];
  payments: ReminderItem[];
  timeZone: string;
  appUrl: string;
}): { subject: string; text: string } {
  const fmt = formatters(input.timeZone);
  const { followups, payments, agentName, appUrl } = input;
  const total = followups.length + payments.length;
  const firstName = agentName.trim().split(/\s+/)[0] || 'there';

  const lines: string[] = [];
  lines.push(`Hi ${firstName},`);
  lines.push('');

  if (total === 0) {
    lines.push('Nothing is waiting on you right now. No follow-ups are due and no payments are outstanding.');
  } else {
    lines.push(`You have ${total} item${total === 1 ? '' : 's'} waiting on you:`);
  }
  lines.push('');

  if (followups.length > 0) {
    lines.push(`FOLLOW-UPS (${followups.length})`);
    followups.slice(0, MAX_ITEMS_PER_SECTION).forEach((item, i) => {
      const when = `${fmt.date(item.when)}, ${fmt.time(item.when)}`;
      const party = item.contact ? `${item.party} - ${item.contact}` : item.party;
      const due = item.overdue === false ? `due ${when}` : `was due ${when}`;
      lines.push(`${i + 1}. ${party}`);
      lines.push(`   ${item.detail} | ${due}`);
    });
    if (followups.length > MAX_ITEMS_PER_SECTION) {
      lines.push(`   ...and ${followups.length - MAX_ITEMS_PER_SECTION} more. Open the app for the full list.`);
    }
    lines.push('');
  }

  if (payments.length > 0) {
    const overdueCount = payments.filter((item) => item.overdue !== false).length;
    const header = overdueCount > 0 ? `PAYMENTS PENDING (${payments.length})` : `PAYMENTS DUE SOON (${payments.length})`;
    lines.push(header);
    payments.slice(0, MAX_ITEMS_PER_SECTION).forEach((item, i) => {
      const party = item.contact ? `${item.party} - ${item.contact}` : item.party;
      const due = item.overdue === false ? `due ${fmt.date(item.when)}` : `overdue since ${fmt.date(item.when)}`;
      lines.push(`${i + 1}. ${party}`);
      lines.push(`   ${item.detail} | ${due}`);
    });
    if (payments.length > MAX_ITEMS_PER_SECTION) {
      lines.push(`   ...and ${payments.length - MAX_ITEMS_PER_SECTION} more. Open the app for the full list.`);
    }
    lines.push('');
  }

  if (total > 0) {
    lines.push('Open your list to mark these done:');
    lines.push(appUrl.replace(/\/+$/, '') + '/today');
  }

  lines.push('');
  lines.push(`This summary repeats every ${DIGEST_INTERVAL_HOURS} hours until you clear each item.`);
  lines.push('You are receiving it because you are assigned these records.');

  const subject =
    total === 0
      ? 'Your summary - all clear'
      : `${total} item${total === 1 ? '' : 's'} waiting - ${followups.length} follow-up${followups.length === 1 ? '' : 's'}, ${payments.length} payment${payments.length === 1 ? '' : 's'}`;

  return { subject, text: lines.join('\n') };
}

/**
 * Register the handler that turns queued EMAIL jobs into real sends. Must be
 * called before `processDueJobs` drains the queue, otherwise EMAIL jobs sit
 * PENDING forever.
 */
export async function registerEmailHandler(): Promise<void> {
  const handler: JobHandler = async (payload) => {
    const data = payload as unknown as EmailJobPayload;
    if (!data?.to || !data?.text) {
      throw new Error('EMAIL job payload is missing a recipient or body');
    }
    const config = await resolveEmailConfig();
    if (!config) {
      throw new Error(
        'Email is not configured; set SMTP credentials or a Resend key (RESEND_API_KEY or an active integration)',
      );
    }
    await sendEmail(config, { to: data.to, subject: data.subject ?? 'CRM update', text: data.text });
  };
  registerJobHandler('EMAIL', handler);
}

/**
 * Build one digest per agent per 12-hour slot from everything overdue or
 * approaching its due time, and queue it for that agent's configured send
 * time. Safe to run often: a slot-scoped unique `digestKey` means repeated
 * runs cannot queue a second email for the same window.
 */
export async function scanReminders(reference: Date = new Date()): Promise<ScanResult> {
  const result: ScanResult = {
    dueItems: 0,
    agentsNotified: 0,
    skippedAlreadyQueued: 0,
    skippedOptedOut: 0,
    skippedInactive: 0,
    skippedNoEmail: 0,
    emailConfigured: false,
  };

  const config = await resolveEmailConfig();
  result.emailConfigured = config !== null;
  if (!config) return result;

  const timeZone = await resolveAppTimeZone();
  const cutoff = endOfLocalDay(reference, timeZone);
  const paymentCutoff = new Date(cutoff.getTime() + PAYMENT_LOOKAHEAD_DAYS * 86_400_000);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim() || 'https://example.com';

  const dueFollowups = await db
    .select({
      id: followups.id,
      type: followups.type,
      scheduledAt: followups.scheduledAt,
      remindBeforeMinutes: followups.remindBeforeMinutes,
      notes: followups.notes,
      assignedTo: followups.assignedTo,
      createdById: followups.createdById,
      leadOwnerId: leads.ownerId,
      leadName: leads.name,
      leadPhone: leads.phone,
      leadWhatsapp: leads.whatsapp,
      customerName: customers.name,
      customerPhone: customers.phone,
      customerOwnerId: customers.ownerId,
    })
    .from(followups)
    .leftJoin(leads, eq(followups.leadId, leads.id))
    .leftJoin(customers, eq(followups.customerId, customers.id))
    .where(
      and(
        eq(followups.status, 'PENDING'),
        // Surfaces a follow-up once it is inside its own lead window, so an
        // upcoming call is visible before it goes late instead of only after.
        lte(
          followups.scheduledAt,
          sql`${reference}::timestamptz + (LEAST(GREATEST(COALESCE(${followups.remindBeforeMinutes}, ${DEFAULT_FOLLOWUP_LEAD_MINUTES}), 0), ${MAX_FOLLOWUP_LEAD_MINUTES}) * interval '1 minute')`,
        ),
      ),
    )
    .orderBy(asc(followups.scheduledAt));

  const pendingPayments = await db
    .select({
      id: paymentDue.id,
      amount: paymentDue.amount,
      paidAmount: paymentDue.paidAmount,
      dueDate: paymentDue.dueDate,
      notes: paymentDue.notes,
      createdById: paymentDue.createdById,
      customerName: customers.name,
      customerPhone: customers.phone,
      customerOwnerId: customers.ownerId,
      leadName: leads.name,
      leadPhone: leads.phone,
      leadOwnerId: leads.ownerId,
    })
    .from(paymentDue)
    .leftJoin(customers, eq(paymentDue.customerId, customers.id))
    .leftJoin(leads, eq(paymentDue.leadId, leads.id))
    .where(
      and(
        inArray(paymentDue.status, ['PENDING', 'PARTIAL']),
        lte(paymentDue.dueDate, paymentCutoff),
        OUTSTANDING_SQL,
      ),
    )
    .orderBy(asc(paymentDue.dueDate));

  const fmt = formatters(timeZone);
  const buckets = new Map<
    string,
    { followups: ReminderItem[]; payments: ReminderItem[] }
  >();

  const bucketFor = (agentId: string) => {
    let bucket = buckets.get(agentId);
    if (!bucket) {
      bucket = { followups: [], payments: [] };
      buckets.set(agentId, bucket);
    }
    return bucket;
  };

  for (const row of dueFollowups) {
    // The query already applies the lead window; repeating the calculation
    // here keeps the two in step if either side has to be clamped differently.
    if (followupVisibleFrom(row.scheduledAt, row.remindBeforeMinutes).getTime() > reference.getTime()) continue;
    const agentId =
      row.assignedTo ?? row.leadOwnerId ?? row.customerOwnerId ?? row.createdById ?? null;
    if (!agentId) continue;
    const party = row.customerName ?? row.leadName ?? 'Unnamed contact';
    const contact = row.customerPhone ?? row.leadPhone ?? row.leadWhatsapp ?? null;
    const note = row.notes?.trim();
    bucketFor(agentId).followups.push({
      kind: 'FOLLOWUP',
      refId: row.id,
      party,
      contact,
      when: row.scheduledAt,
      detail: note ? `${row.type} - ${note}` : row.type,
      // False while the follow-up is still inside its lead window, so the
      // digest can call it upcoming instead of reporting it as already late.
      overdue: row.scheduledAt.getTime() < reference.getTime(),
    });
  }

  // The query already gates on outstanding balance, but the check is repeated
  // here so a numeric value Postgres accepted and JS cannot parse still cannot
  // put a "INR 0 left" line in an agent's inbox.
  let paymentItems = 0;
  for (const row of pendingPayments) {
    if (!hasOutstandingDue(row.amount, row.paidAmount)) continue;
    const agentId = row.customerOwnerId ?? row.leadOwnerId ?? row.createdById ?? null;
    if (!agentId) continue;
    const party = row.customerName ?? row.leadName ?? 'Unnamed contact';
    const contact = row.customerPhone ?? row.leadPhone ?? null;
    const note = row.notes?.trim();
    const label = outstandingLabel(fmt.money, toNumber(row.amount) ?? 0, toNumber(row.paidAmount) ?? 0);
    bucketFor(agentId).payments.push({
      kind: 'PAYMENT',
      refId: row.id,
      party,
      contact,
      when: row.dueDate,
      detail: note ? `${label} - ${note}` : label,
      overdue: row.dueDate.getTime() < reference.getTime(),
    });
    paymentItems += 1;
  }

  let followupItems = 0;
  for (const bucket of buckets.values()) followupItems += bucket.followups.length;
  result.dueItems = followupItems + paymentItems;
  if (buckets.size === 0) return result;

  const agentIds = [...buckets.keys()];
  const agents = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      isActive: users.isActive,
      remindersEnabled: users.remindersEnabled,
      reminderTime: users.reminderTime,
    })
    .from(users)
    .where(inArray(users.id, agentIds));

  for (const agent of agents) {
    const bucket = buckets.get(agent.id);
    if (!bucket) continue;

    if (!agent.isActive) {
      result.skippedInactive += 1;
      continue;
    }
    if (!agent.remindersEnabled) {
      result.skippedOptedOut += 1;
      continue;
    }
    if (!agent.email || !isValidEmail(agent.email)) {
      result.skippedNoEmail += 1;
      continue;
    }

    const { hour, minute } = parseReminderTime(agent.reminderTime);
    const sortedFollowups = [...bucket.followups].sort((a, b) => a.when.getTime() - b.when.getTime());
    const sortedPayments = [...bucket.payments].sort((a, b) => a.when.getTime() - b.when.getTime());
    const total = sortedFollowups.length + sortedPayments.length;
    if (total === 0) continue;

    const digest = buildReminderDigest({
      agentName: agent.name,
      followups: sortedFollowups,
      payments: sortedPayments,
      timeZone,
      appUrl,
    });

    const slots = digestSlots(hour, minute);
    for (let slot = 0; slot < slots.length; slot += 1) {
      const { hour: slotHour, minute: slotMinute } = slots[slot];
      const sendAt = zonedWallClock(reference, timeZone, slotHour, slotMinute);
      // A slot that already passed long ago belongs to a window the agent has
      // moved past; sending it now would just be noise.
      if (sendAt.getTime() < reference.getTime() - DIGEST_INTERVAL_HOURS * 3_600_000) {
        result.skippedAlreadyQueued += 1;
        continue;
      }

      const digestKey = `reminder-digest:${agent.id}:${localDateKey(sendAt, timeZone)}:${slot}`;
      // The insert below is the real guard (ON CONFLICT DO NOTHING), so this
      // read is only an optimisation that avoids a pointless write attempt.
      const existing = await db.query.backgroundJobs.findFirst({
        where: eq(backgroundJobs.digestKey, digestKey),
        columns: { id: true },
      });
      if (existing) {
        result.skippedAlreadyQueued += 1;
        continue;
      }

      const queued = await enqueueJobOnce(
        'EMAIL',
        { to: agent.email, subject: digest.subject, text: digest.text, agentId: agent.id },
        { runAt: sendAt, priority: 3, maxAttempts: 3, digestKey },
      );
      // A false here means a concurrent scan won the race for this slot, so the
      // window is covered and counting it as notified would over-report.
      if (queued) result.agentsNotified += 1;
      else result.skippedAlreadyQueued += 1;
    }
  }

  return result;
}

export interface ClientPaymentScanResult {
  /** EMAIL jobs actually inserted. */
  remindersQueued: number;
  /** Payments skipped because neither customer nor lead carries an address. */
  skippedNoEmail: number;
  /** Payments where the before/due email was already queued. */
  skippedAlreadyQueued: number;
  /** Payments whose due date has already passed here - no client reminder after the date. */
  skippedPastDue: number;
  emailConfigured: boolean;
}

/**
 * Scan for client-facing payment reminders. Unlike the agent digest, each
 * payment gets at most two emails, pinned to the reminder hour on the local
 * calendar: one on `dueDate - 1` ("due tomorrow") and one on `dueDate` itself
 * ("due today"). Payments that have already passed their due date are never
 * emailed - chasing is the agent's job, and a late bill reminder to an already
 * late client is noise. Idempotency rides on `digestKey` scoped per payment
 * and send-type (`before` / `due`), so re-runs cannot double-email a client.
 */
export async function scanClientPaymentReminders(reference: Date = new Date()): Promise<ClientPaymentScanResult> {
  const result: ClientPaymentScanResult = {
    remindersQueued: 0,
    skippedNoEmail: 0,
    skippedAlreadyQueued: 0,
    skippedPastDue: 0,
    emailConfigured: false,
  };

  const config = await resolveEmailConfig();
  result.emailConfigured = config !== null;
  if (!config) return result;

  const timeZone = await resolveAppTimeZone();
  const hour = DEFAULT_REMINDER_HOUR;
  const minute = DEFAULT_REMINDER_MINUTE;

  const pending = await db
    .select({
      id: paymentDue.id,
      amount: paymentDue.amount,
      paidAmount: paymentDue.paidAmount,
      dueDate: paymentDue.dueDate,
      customerName: customers.name,
      customerEmail: customers.email,
      leadName: leads.name,
      leadEmail: leads.email,
    })
    .from(paymentDue)
    .leftJoin(customers, eq(paymentDue.customerId, customers.id))
    .leftJoin(leads, eq(paymentDue.leadId, leads.id))
    .where(
      and(
        inArray(paymentDue.status, ['PENDING', 'PARTIAL']),
        OUTSTANDING_SQL,
      ),
    )
    .orderBy(asc(paymentDue.dueDate));

  const fmt = formatters(timeZone);
  const senderName = config.fromName?.trim() || 'CRM';
  const todayStart = zonedWallClock(reference, timeZone, 0, 0);

  for (const row of pending) {
    if (!hasOutstandingDue(row.amount, row.paidAmount)) continue;

    // Both emails are anchored to the local calendar day the payment is due on,
    // not to the exact instant it lands in the database.
    const dueDayStart = zonedWallClock(row.dueDate, timeZone, 0, 0);
    if (dueDayStart.getTime() < todayStart.getTime()) {
      result.skippedPastDue += 1;
      continue;
    }

    const to = (row.customerEmail ?? row.leadEmail ?? '').trim();
    if (!isValidEmail(to)) {
      result.skippedNoEmail += 1;
      continue;
    }

    const party = (row.customerName ?? row.leadName ?? 'there').trim();
    const label = outstandingLabel(fmt.money, toNumber(row.amount) ?? 0, toNumber(row.paidAmount) ?? 0);
    const dueKey = localDateKey(row.dueDate, timeZone);

    // "Due tomorrow" fires 24h before the due day, at the configured reminder
    // hour; "due today" fires on the due day itself. Both are gated by
    // `enqueueJobOnce`'s unique digestKey so a scan re-run cannot queue a
    // second copy.
    const beforeSendAt = zonedWallClock(
      new Date(dueDayStart.getTime() - 86_400_000),
      timeZone,
      hour,
      minute,
    );
    const dueSendAt = zonedWallClock(row.dueDate, timeZone, hour, minute);

    const touches: { sendAt: Date; kind: 'before' | 'due'; subject: string; text: string }[] = [];
    if (beforeSendAt.getTime() > reference.getTime()) {
      touches.push({
        sendAt: beforeSendAt,
        kind: 'before',
        subject: `Payment due tomorrow: ${label}`,
        text: [
          `Hi ${party},`,
          '',
          `A friendly reminder that a payment of ${label} is due tomorrow (${fmt.date(row.dueDate)}).`,
          '',
          'If you have already made this payment, please ignore this email. For any questions, reply to this email.',
          '',
          'Regards,',
          senderName,
        ].join('\n'),
      });
    }
    touches.push({
      sendAt: dueSendAt,
      kind: 'due',
      subject: `Payment due today: ${label}`,
      text: [
        `Hi ${party},`,
        '',
        `A friendly reminder that a payment of ${label} is due today (${fmt.date(row.dueDate)}).`,
        '',
        'If you have already made this payment, please ignore this email. For any questions, reply to this email.',
        '',
        'Regards,',
        senderName,
      ].join('\n'),
    });

    for (const touch of touches) {
      const digestKey = `client-payment:${row.id}:${dueKey}:${touch.kind}`;
      // The insert below is the real guard (ON CONFLICT DO NOTHING); this read
      // only avoids a pointless write attempt on a re-scan.
      const existing = await db.query.backgroundJobs.findFirst({
        where: eq(backgroundJobs.digestKey, digestKey),
        columns: { id: true },
      });
      if (existing) {
        result.skippedAlreadyQueued += 1;
        continue;
      }

      const queued = await enqueueJobOnce(
        'EMAIL',
        { to, subject: touch.subject, text: touch.text },
        { runAt: touch.sendAt, priority: 2, maxAttempts: 3, digestKey },
      );
      if (queued) result.remindersQueued += 1;
      else result.skippedAlreadyQueued += 1;
    }
  }

  return result;
}
