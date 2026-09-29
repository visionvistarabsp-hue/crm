# Lead Operations section — design

**Date:** 2026-09-29
**Status:** Approved by user (Hinglish conversation)

## Problem

A lead's operational activity is scattered. Follow-ups live on `/followups`,
site visits/meetings on `/meetings`, bookings/payments on `/bookings` and the
customer 360 page, agreement documents on `/documents`, and the lead detail
page itself only shows a bare note feed (`lead_activities`) with no status
roll-up. A salesperson opening a lead cannot tell at a glance where the deal
stands, whether the next visit is booked, or whether the agreement is in.

## Scope

Enhance the existing lead detail page — **no tabs, same URL**
(`/leads/[id]`) — by replacing the bare "Activity" card with a single
**Operations** section containing:

1. A **status snapshot** (tiles) — the operational position of the lead today.
2. A **combined timeline** — every operational event for the lead in one
   reverse-chronological feed, including outbound emails/WhatsApp from the
   new `message_logs`.

Everything is read-only except the existing inline "Add a note" composer,
which stays. Agreement is represented from existing data — no new entity.

## Data sources (all existing)

| Table | Used for |
|---|---|
| `followups` | next follow-up tile + `FOLLOWUP` events |
| `meetings` (`type='SITE_VISIT'`) | site-visit tile + `SITE_VISIT`/`MEETING` events |
| `bookings` (by `leadId`) | booking tile + `BOOKING` events |
| `payments` (via the lead's booking ids) | collected-amount tile + `PAYMENT` events |
| `documents` (`leadId` + `documentType IN (AGREEMENT, BOOKING_FORM)`) | agreement tile + `DOCUMENT` events |
| `lead_status_history` | `STATUS_CHANGE` events |
| `lead_activities` (subset) | `NOTE`/`MERGE`/`ASSIGNMENT`/`IMPORT`/`SYSTEM` events |
| `message_logs` (via `listOutboundMessages({ leadId })`) | `MESSAGE` events |

Notes on mapping:

- **Payments have no `leadId` column** — they reach a lead only through
  `bookings.leadId`. Query the lead's bookings first, collect their ids, then
  query payments with `inArray(payments.bookingId, ids)`.
- **`documents.leadId` is set at upload but nothing filters by it** — this is
  the first real consumer.
- **No double rows.** Events whose source entity has its own table come from
  that table, and the corresponding auto-written `lead_activities` rows are
  skipped: `FOLLOWUP_CREATED`, `SITE_VISIT`, `MEETING`, `BOOKING`, `PAYMENT`,
  `CANCELLATION`, `STATUS_CHANGE`. Only activity kinds with no other home are
  kept (`NOTE`, `MERGE`, `ASSIGNMENT`, `IMPORT`, `SYSTEM`).
- Payments with status `BOUNCED`/`REVERSED` are dropped from the timeline and
  from the collected total (same rule as `customerHistory.ts`).

## API

New route: `GET /api/leads/[id]/operations`

- Authorized like other lead endpoints: `resolveVisibleUserIds` gate on the
  lead's `ownerId`; `404` if the lead is missing or not visible.
- Returns:
  ```
  {
    lead:   { id, leadNo, name, status },
    summary: {
      nextFollowup:   { id, scheduledAt, status } | null,   // earliest PENDING
      overdueCount:   number,                               // PENDING & past
      visits:         { completed, nextScheduledAt | null },
      booking:        { id, bookingNo, status } | null,     // most recent non-cancelled
      agreement:      { title, fileName, verificationStatus } | null,  // latest AGREEMENT doc
      amountCollected: number,
    },
    timeline: [ { id, kind, title, detail, amount, status, at, refId, actorName } ]
  }
  ```

## Service

New module `src/lib/services/leadOperations.ts` → `getLeadOperations(actor, leadId)`.

- Fetches all tables in one `Promise.all` of `db.query.<table>.findMany`
  (followups, meetings, bookings, documents) plus the derived payments query
  and a `leadActivities`/`leadStatusHistory` pair — mirroring
  `getCustomer360` in `customerHistory.ts`.
- Reuses the small helpers `toNumber`/`iso` (imported from
  `customerHistory.ts`'s `__testables`, or a local copy — prefer importing).
- Defines its **own** `LeadOpsKind` union and timeline entry shape. The shared
  `TimelineKind`/`TimelineEntry` in `customerHistory.ts` stays untouched so the
  customer 360 page's exhaustive kind filter is not forced to widen.
- Sorts reverse-chronologically. The sort is 8 lines; mirror `buildTimeline`
  locally rather than loosening the shared type.
- Outbound messages come from `listOutboundMessages({ leadId })` (existing,
  already tested) — no duplicate DB plumbing.

## UI

- New client component `src/components/LeadOperations.tsx`.
- Renders one `Card` (`CardHeader title="Operations"`):
  - **Note composer** — the existing inline "Add a note" form, moved as-is.
    On post it hits `/api/leads/[id]/activities` then reloads the operations
    payload.
  - **Status tiles** — a small responsive grid: Next follow-up (time +
    overdue warning), Site visits (`N done`, next date), Booking (status +
    bookingNo), Agreement (verification status), Collected (₹ amount).
  - **Filter pills** — All + one per kind present (mirrors the customer page's
    `KINDS` filter pattern).
  - **Feed** — one row per event: kind badge (tone per kind), title/detail,
    `at` timestamp, ₹ amount where relevant. Empty state: "No activity yet".
- The lead page (`src/app/(app)/leads/[id]/page.tsx`) replaces the "Activity"
  card (lines 105–131) with `<LeadOperations leadId={id} />` and **removes its
  now-redundant `/activities` `useApi` fetch** (the operations payload includes
  everything the feed showed). The status/assignee/Linked cards stay.
- `useApi('/api/leads/[id]/operations', { deps: [id] })` inside the component.

## Error handling

- Route/service: 404 for missing/invisible lead; 400 never (read-only).
- DB failure on any parallel query → the route fails as a 500 via the shared
  `ApiError`/handler path, same as the existing lead endpoints.
- UI: `ApiErrorView` with retry on load failure; empty states per section.

## Testing

- New `src/tests/leadOperations.test.ts`, mock `@/lib/db` per-table like
  `whatsapp.test.ts`/`messageLog.test.ts`:
  - Summary: earliest PENDING follow-up chosen; overdue count; site-visit
    completed count + next scheduled; latest non-cancelled booking; latest
    AGREEMENT document verification; collected total sums RECEIVED payments
    only and excludes BOUNCED/REVERSED.
  - Timeline: reverse-chron sort; duplicate activity kinds skipped
    (`FOLLOWUP_CREATED` etc.); payments dropped when bounced/reversed;
    message-log events present; kind mapping correct.
  - Visibility: non-owner → 404; missing lead → 404.
- Existing suites (whatsapp, messageLog, leadAlerts, customerHistory) must
  stay green — no changes to their inputs.

## Out of scope

- No new agreement entity/workflow.
- No tabs; page stays a single scroll.
- No writes beyond the existing note composer.
- No kanban/board.