import { NextResponse, type NextRequest } from 'next/server';
import { processDueJobs } from '@/lib/queue';
import { registerReminderHandler } from '@/lib/notifications';
import { registerEmailHandler, scanReminders } from '@/lib/reminders';
import { scanUnclaimedLeads } from '@/lib/leadAlerts';
import { registerIntegrationSyncHandler, scanIncomingLeads } from '@/lib/services/incomingLeadSync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Internal: scans for due reminders, then drains the background job queue
 * (cron-invoked).
 *
 * Must stay secret. This endpoint triggers notifications, reminders and
 * automations, so an open route lets anyone drive that work on demand. Vercel
 * Cron sends `Authorization: Bearer $CRON_SECRET`; anything else is rejected.
 * The check fails closed - an unset CRON_SECRET locks the route rather than
 * leaving it open.
 */
function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get('authorization') ?? '';
  return header === `Bearer ${secret}`;
}

/**
 * Job handlers live in a module-level map that only gets populated when the
 * owning module's registration function runs. Nothing in the app used to call
 * them, so REMINDER and NOTIFY jobs were enqueued, never handled, and sat PENDING
 * forever. Registration belongs here, next to the only code that drains the
 * queue. `registerJobHandler` overwrites by job type, so calling this on every
 * invocation is idempotent.
 */
async function ensureHandlers(): Promise<void> {
  await registerReminderHandler();
  await registerEmailHandler();
  registerIntegrationSyncHandler();
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: { message: 'Forbidden' } }, { status: 403 });
  }
  try {
    await ensureHandlers();

    // A scanner fault must not strand every other job type, so the scan is
    // isolated and the queue still drains.
    let reminders: unknown = null;
    let escalations: unknown = null;
    let scanError: string | null = null;
    try {
      reminders = await scanReminders();
    } catch (err) {
      scanError = err instanceof Error ? err.message : String(err);
      console.error('[process-queue] reminder scan failed', err);
    }

    // Same isolation as the reminder scan, and deliberately a second try
    // block: a broken escalation query must not be able to stop reminders.
    let escalationError: string | null = null;
    try {
      escalations = await scanUnclaimedLeads();
    } catch (err) {
      escalationError = err instanceof Error ? err.message : String(err);
      console.error('[process-queue] unclaimed lead scan failed', err);
    }

    // Incoming-lead reconciliation, isolated the same way. A failing sweep is
    // reported but must not strand reminders or the queue drain behind it.
    let incoming: unknown = null;
    let incomingError: string | null = null;
    try {
      incoming = await scanIncomingLeads();
    } catch (err) {
      incomingError = err instanceof Error ? err.message : String(err);
      console.error('[process-queue] incoming reconciliation scan failed', err);
    }

    const processed = await processDueJobs(25);
    return NextResponse.json({
      ok: scanError === null && escalationError === null && incomingError === null,
      processed,
      reminders,
      escalations,
      incoming,
      scanError,
      escalationError,
      incomingError,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

export const POST = GET;