# New Lead Alerts & Manager Escalation — Design

- **Date:** 2026-09-29
- **Status:** Approved
- **Scope item:** #3 of the audit sequence (`#3 new-lead alert` → `#4 webhook security/retry` → `#2 token/webhook wizard`)

## Problem

`createLead()` fires no notification. The only `notifyUser()` call in the lead
service fires on the duplicate-resolution path, so a genuinely new lead is
silent until someone opens the app. The existing 12-hour digest covers
follow-ups and payments but not arrivals, and by then a hot ad lead is cold.

The 12-hour digest stays exactly as it is. This feature adds a real-time path
and deliberately does not touch `DIGEST_INTERVAL_HOURS`, the 5-minute cron, the
60-minute default follow-up, the `[0, 1440]` clamp, or the
`reminder-digest:${agentId}:${localDateKey}:${slot}` key format.

## Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Delivery | Immediate email + in-app | Cold-lead loss is the cost of delay. The digest cannot cover an arrival. |
| Recipients | Owner now, manager after 30 min | Keeps the blast radius at one person while guaranteeing a second pair of eyes. |
| Trigger scope | Every new lead, including manual | Manual entries are how walk-ins and front-desk leads enter. They were silent too. |
| Self-created | Still notify the creator | Explicitly chosen for accountability/visibility over notification comfort. |
| Burst | One email per lead | Explicitly chosen over batching. The opt-out switch is the relief valve. |
| Handled | Any activity stops escalation | A call logged but no status change is still handled; the user chose activity, not state. |
| Escalation mechanism | Cron scanner + `firstTouchedAt` column | Reuses the proven `scanReminders` pattern and stores "handled" explicitly. |

## Approaches considered

**Approach 1 — Cron scanner + `firstTouchedAt` column (chosen).**
A 5-minute scan finds untouched `NEW` leads and escalates once per lead, keyed
by a unique `digestKey`. Matches the existing scanner, survives cron restarts,
and leaves an auditable record of whether a lead was handled.

**Approach 2 — Cron scanner, no migration.** Same scanner, but "touched" is
derived by counting `leadStatusHistory` rows and filtering the auto-generated
`"Lead created from …"` activity out of `leadActivities`. Rejected: the
string-match filter is fragile and "handled" would have to be recomputed on
every query.

**Approach 3 — Per-lead delayed queue job.** A `LEAD_ESCALATION_CHECK` job
scheduled at `now + 30m`. Rejected: a new job type and handler, one extra
`background_jobs` row per lead, and an expiry path that silently drops leads.
Buying exact-30-minute precision is not worth it when 30–35 min is
operationally identical.

## Architecture

New module `src/lib/leadAlerts.ts`. Two independent paths.

```
Path A — owner alert, immediate
  createLead() commits -> assignLead() -> notifyOwnerOfNewLead(lead)
    |- notifyUser(ownerId, ...)                    in-app
    `- enqueueJobOnce('EMAIL', ..., digestKey: lead-alert:<leadId>:<ownerId>)

Path B — manager escalation, cron-driven
  GET /api/internal/process-queue  (every 5 min)
    `- scanUnclaimedLeads()
         |- leads where status='NEW' AND firstTouchedAt IS NULL
         |        AND createdAt < now - 30min AND ownerId IS NOT NULL
         |- manager = owner.managerId, else active ADMIN/SUPER_ADMIN
         |- skip when manager unresolved
         `- notify + enqueue with digestKey: lead-escalation:<leadId>
```

Path B is a scanner, not a per-lead job, so escalation lands 30–35 minutes
after arrival depending on cron phase. That is an accepted trade-off, not an
oversight.

Both paths fail independently. A Resend outage still leaves the in-app
notification delivered. A dead cron still leaves the owner alert sent; only
escalation runs late.

`markLeadTouched(leadId)` stamps `firstTouchedAt` and is called from
`updateLead()`, `changeStatus()` and `addLeadActivity()`. It is deliberately
**not** called from `createLead()` — that would mark every new lead handled on
arrival and permanently disable escalation.

## Data model

One migration adds three nullable/boolean columns:

- `leads.firstTouchedAt` (`timestamptz`, null) — set on first human touch.
- `leads.escalatedAt` (`timestamptz`, null) — set when the manager alert is
  queued. Gives the operator a durable, queryable answer to "was this escalated?"
  instead of inferring it from job history.
- `users.newLeadAlertsEnabled` (`boolean`, not null, default `true`) — opt-out,
  separate from `remindersEnabled` because a user may want to mute the 12-hour
  digest while keeping real-time alerts.

The partial index

```sql
CREATE INDEX idx_leads_unclaimed
  ON leads (created_at)
  WHERE status = 'NEW' AND first_touched_at IS NULL AND escalated_at IS NULL;
```

keeps the scan cheap as untouched leads accumulate. `idx_leads_created` already
covers the `created_at` range, so the index is not required for correctness —
it is an optimisation. Every existing index on `leads` is a plain non-partial
index, so this is the first partial one; it matters because the scan only ever
wants `NEW` + untouched + un-escalated rows, a small fraction of the table, and
without it each 5-minute tick re-reads every lead in the window and discards
almost all of them. The cost is one extra index to update on the lead writes
that change any of the three indexed predicates.

## Trigger points

The alert call goes at the end of `createLead()`, after the transaction
commits and after assignment resolves:

```ts
// existing tail of createLead()
await assignLead({ lead: created, actor, skipIfAssigned: false });
await runAutomations('LEAD_CREATED', { leadId: created.id }, actor);
await writeAudit({ /* ... */ });

void notifyOwnerOfNewLead(created).catch((err) =>
  console.error('[leadAlerts] owner alert failed', err),
);

return { lead: created, duplicates };
```

The insert runs inside a `db.transaction` callback and `created` is captured
from it, so there is no commit handle to await — the transaction has already
resolved by the time this line runs.

Firing last, detached, is required. An alert failure must never roll back a
real lead, so it is not awaited inline; `void` plus `.catch()` keeps an
unhandled rejection out of the request path. Assignment must have resolved
first, otherwise `created.ownerId` can be `null` and the lead reaches nobody —
the webhook path that creates leads does not always have an owner yet.

This is separate from the existing duplicate-resolution `notifyUser()`. A lead
flagged as a duplicate is still a new arrival that someone has to dispose of,
so it gets its own alert; the duplicate notice is additive, not a substitute.

## Escalation scanner

`scanUnclaimedLeads(reference = new Date())` selects leads where:

- `status = 'NEW'`
- `firstTouchedAt IS NULL`
- `createdAt < reference - ESCALATION_MINUTES` (30)
- `ownerId IS NOT NULL`
- `escalatedAt IS NULL`

Manager resolution walks `owner.managerId` first, then falls back to active
`ADMIN`/`SUPER_ADMIN` users so an escalation is never dropped just because the
reporting line is empty. When no manager resolves, the lead is counted as
skipped rather than silently ignored, and the scanner returns that count.

Each escalation enqueues with `digestKey: lead-escalation:<leadId>`. The unique
index on `background_jobs.digestKey` makes the insert the real guard, so a
concurrent or repeated scan cannot double-send. `escalatedAt` is stamped in the
same write so the row stops appearing in the next scan.

In `process-queue/route.ts` the new scan is wrapped in its own try/catch,
mirroring how `scanReminders()` is isolated. A scanner fault must not strand
the reminder scan or the queue drain, and it must not fail the cron request.

## Configuration

A toggle on the settings page writes `users.newLeadAlertsEnabled`. Off means
neither the immediate alert nor the escalation is sent for that user as
recipient. It does not stop the lead from being created, and it does not affect
the 12-hour digest.

## Failure modes

| Failure | Behaviour |
| --- | --- |
| Resend unconfigured or down | `EMAIL` job retries per its `maxAttempts`, then fails. In-app notification already delivered. |
| `notifyOwnerOfNewLead` throws | Logged, swallowed by the `.catch()`. Lead stands. |
| Scanner throws | Caught in the cron route. Reminders and queue drain continue. |
| Two scans race | Unique `digestKey` on `background_jobs` lets one win. |
| Cron down for hours | Escalation fires on the next successful tick; `createdAt` is the reference, not the tick time, so a lead is never escalated before it is 30 min old. |
| Owner has no manager and no admin exists | Counted as skipped and surfaced in the scan result. |

## Tests

New file `src/tests/leadAlerts.test.ts`:

- owner receives in-app and an `EMAIL` job on create
- `firstTouchedAt` set suppresses escalation
- a lead younger than 30 minutes is not escalated
- a lead at or past the threshold is escalated
- a second scan does not re-escalate the same lead
- missing manager falls back to `ADMIN`
- unresolved manager is skipped and counted
- unassigned lead is skipped
- in-app notification survives an email enqueue failure
- a user with `newLeadAlertsEnabled = false` receives nothing

Existing reminder invariants are asserted in the same file so the 12-hour digest
cannot regress silently.

## Rollout

1. Migration (columns + partial index).
2. `src/lib/leadAlerts.ts`.
3. `markLeadTouched()` wiring in `updateLead` / `changeStatus` / `addLeadActivity`.
4. `notifyOwnerOfNewLead()` call in `createLead`.
5. `scanUnclaimedLeads()` plus cron wiring.
6. Settings toggle.
7. `npm.cmd test`, `npm.cmd run typecheck`, `npm.cmd run lint`,
   `npm.cmd run build`.

## Out of scope

- Batching bursts into one email (explicitly declined).
- WhatsApp delivery. No provider is configured; this ships email and in-app only.
- Per-channel or per-lead-type preferences beyond the single on/off switch.
- Changes to the digest, its schedule, or its dedupe key.
- #4 (Meta webhook signature verification and retry) and #2 (the self-serve
  webhook/token wizard), which stay separate specs.
