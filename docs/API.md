# API Reference

Base URL: `APP_BASE_URL` (e.g. `http://localhost:3000`).

## Conventions

- **Auth**: every route is wrapped in `withApi` (JSON in/out, `401` when unauthenticated) or `withPublic` (whitelisted, below). With `AUTH_DEMO_MODE=true` a seeded `demo` SUPER_ADMIN is used.
- **Errors**: `{ error: { message } }` with `400` (validation, ZodError → `422`), `401`, `403` (missing permission), `404`, `500`.
- **Pagination**: `?page=1&pageSize=50` (default 50, max configurable per route). Lists return `{ items, total, page, pageSize }`.
- **Money**: all amounts travel as decimal strings (`"144000.00"`), stored as `numeric(14,2)`.
- **Dates**: ISO-8601 strings via `datetime-local`-friendly parsing.

### Public endpoints
| Method | Route | Notes |
|---|---|---|
| GET | `/api/health` | `200 { ok: true }` — used by deploy health checks |
| POST | `/api/webhooks/leads` | lead intake; requires header `x-webhook-secret: <WEBHOOK_SECRET>` |
| GET/POST | `/api/internal/process-queue` | background job drainer (due follow-up jobs, max 25); protect with cron-only network access |

---

## Auth
| Method | Route | Notes |
|---|---|---|
| GET | `/api/auth/me` | current actor `{ user, permissions }`; `/login` (demo) loads this |

## Leads
| Method | Route | Notes |
|---|---|---|
| GET | `/api/leads` | filters: `q`, `status`, `ownerId`, `source`, `assignedToMe`, `followUpDue`, `from`, `to`; response flattens `ownerName`, `assignedAs`, `projectInterest` |
| POST | `/api/leads` | create: `name`, `phone`, `whatsapp?`, `email?`, `source`, `city?`, `budget?`, `projectInterest?`, `note?` (+ `assignToMe?`) |
| GET | `/api/leads/[id]` | single lead + `activities`, `followUps`, `meetings`, `assignments`, `duplicates` |
| PATCH | `/api/leads/[id]` | update fields; status changes validated by status machine |
| DELETE | `/api/leads/[id]` | soft-delete + audit |
| POST | `/api/leads/[id]/status` | `{ status, note?, followUpAt? }` — transition via status machine; auto-creates follow-up |
| POST | `/api/leads/[id]/assign` | `{ userId, rule? (auto|manual) }` — manual assignment or round-robin (team leader → execs) |
| GET | `/api/leads/[id]/activities` | list timeline activities on a lead |
| POST | `/api/leads/[id]/activities` | add activity `{ type, note?, description? }` |
| POST | `/api/leads/merge` | merge two leads: `{ keepId, mergeId }` (moves customers/bookings/activities) |
| POST | `/api/leads/duplicates` | resolve a duplicate candidate: `{ id, action: 'MARK_DUPLICATE'|'NOT_DUPLICATE' }` |
| GET | `/api/export/leads` | CSV download (all leads honoring permission + filters) |

## Customers
| Method | Route | Notes |
|---|---|---|
| GET | `/api/customers` | filters `q`, `source`; paginated |
| POST | `/api/customers` | create customer |
| GET | `/api/customers/[id]` | detail + booking/documents summaries |
| PATCH | `/api/customers/[id]` | update |
| DELETE | `/api/customers/[id]` | no-op when referenced by bookings |

## Follow-ups & Meetings
| Method | Route | Notes |
|---|---|---|
| GET | `/api/followups` | `?view=today\|upcoming\|overdue\|completed\|all` |
| POST | `/api/followups` | `{ leadId, title, scheduledAt, note? }` |
| GET/PATCH/DELETE | `/api/followups/[id]` | fetch / update / delete |
| POST | `/api/followups/[id]` | `{ completed: true, outcome? }` — mark complete |

| Method | Route | Notes |
|---|---|---|
| GET | `/api/meetings` | list (filterable) |
| POST | `/api/meetings` | schedule `{ leadId?, customerId?, type, scheduledAt, agenda?, notes? }` |
| PATCH | `/api/meetings/[id]` | update/reschedule |
| POST | `/api/meetings/[id]` | `{ status }` — set `COMPLETED`/`CANCELLED`/`NO_SHOW` |
| DELETE | `/api/meetings/[id]` | cancel meeting |

## Inventory
| Method | Route | Notes |
|---|---|---|
| GET | `/api/projects` | list + `towerCount`, `unitStats` (total/available/held/booked/inventory value) |
| POST | `/api/projects` | create project |
| GET | `/api/projects/[id]` | detail + towers + tower stats |
| PATCH | `/api/projects/[id]` | update |
| DELETE | `/api/projects/[id]` | only when no towers |
| PUT | `/api/projects/[id]` | `{ name, floors, unitsPerFloor }` — create tower + auto-generate units |

| Method | Route | Notes |
|---|---|---|
| GET | `/api/units` | filters `projectId`, `towerId`, `status`, `bhk`, `q`; includes `project` & `tower` |
| POST | `/api/units` | create single unit |
| GET/PATCH/DELETE | `/api/units/[id]` | fetch / update / delete |
| POST | `/api/units/[id]` | actions: `{ action: 'hold', holdUntil }` or `{ action: 'release' }` |

## Bookings, Payments, Cancellations, Refunds
| Method | Route | Notes |
|---|---|---|
| GET | `/api/bookings` | filters `status`, `projectId`, `salespersonId`, `customerId`, `from`, `to`, `q`; flattened `customerName`, `projectName`, `unitNo`, `salespersonName` |
| POST | `/api/bookings` | create: `customerId` **or** `leadId` **or** `newCustomer`; `projectId`, `unitId`, `saleValue`, `bookingAmount`, `salespersonId?`, `bookingDate`. Locks unit (`FOR UPDATE`), fences `AVAILABLE`/`HOLD`, converts lead→customer, generates commission snapshots |
| GET | `/api/bookings/[id]` | booking + `payments`, `cancellations`, `commissionSnapshots` |
| PATCH | `/api/bookings/[id]` | update (re-seals commissions when sale value changes) |
| POST | `/api/bookings/[id]` | add payment `{ amount, paymentDate, method, reference?, status? }` |
| POST | `/api/bookings/[id]/cancel` | request cancellation `{ reason, reasonCategory?, refundAmount?, notes? }` → approval pending |
| GET | `/api/cancellations` | list PENDING/APPROVED/REJECTED cancellations |
| POST | `/api/cancellations/[id]/approve` | `{ approved: true, refundAmount? }` — releases unit, auto-refunds, reverses commissions |
| POST | `/api/refunds` | manual refund `{ cancellationId, refundAmount, method, reference? }` |

## Commissions & Payouts
| Method | Route | Notes |
|---|---|---|
| GET | `/api/commissions/rules` | active/archived versioned rules |
| POST | `/api/commissions/rules` | create rule: `{ name, type, payableTo, personId?, rate?, fixedAmount?, slabConfig?, active }` |
| PATCH | `/api/commissions/rules/[id]` | update → inserts a NEW version, deactivates the old (history immutable) |
| GET | `/api/commissions/dashboard` | `grossCommission, pending, payable, approved, paid, reversed, outstandingBalance, snapshotCount` |
| GET | `/api/commissions/summary/[personId]` | entitlements per person |
| GET | `/api/payouts` | payout batches: `?status=` (DRAFT/PROCESSING/PROCESSED/FINALIZED) |
| POST | `/api/payouts` | create batch (from payable snapshots) |
| POST | `/api/payouts/[id]` | `{ action: 'process' | 'finalize' }` |
| POST | `/api/payouts/tx/[txId]` | `{ reverse: true }` — reverse a paid transaction |
| GET | `/api/payouts/dashboard` | totals by status |

## Documents
| Method | Route | Notes |
|---|---|---|
| GET | `/api/documents` | filters `customerId`, `bookingId`, `type`, `q` |
| POST | `/api/documents` | `multipart/form-data`: `file`, `title`, `documentType?`, `customerId?`, `bookingId?`, `leadId?` (50 MB cap, MIME allowlist) |
| GET | `/api/documents/[id]?mode=url` | metadata, or presigned URL when `mode=url` |
| POST | `/api/documents/[id]` | `{ verified: true }` — mark verified |
| DELETE | `/api/documents/[id]` | delete file + row |
| GET | `/api/documents/file/[id]` | authenticated byte stream (proxy) — used by the download button |

## Insights & Ops
| Method | Route | Notes |
|---|---|---|
| GET | `/api/dashboard` | KPIs + 6-month trend + quick actions for the actor |
| GET | `/api/reports/sales` | `?year=` — `summary` + `byUser`, `byProject`, `byStatus` |
| GET | `/api/reports/cancellations` | `?year=` — list + `totalRefund` |
| GET | `/api/search?q=` | `?scope=leads\|customers\|bookings\|units` (default all) |
| GET | `/api/notifications` | paginated; `?unread=true` for badge count |
| POST | `/api/notifications/read` | `{ id }` or `{ id: 'all' }` |
| GET | `/api/team` | user list + role labels |
| GET | `/api/settings?key=<k>` | single value; `?key=__all__` → all |
| POST | `/api/settings` | `{ key, value }` — integration keys / UI prefs |
| GET/POST | `/api/automation-rules` | list / create automation rules |
| PATCH | `/api/automation-rules/[id]` | update rule |
| POST | `/api/automation-rules/[id]` | toggle `isActive` |
| DELETE | `/api/automation-rules/[id]` | delete rule |

## Permissions model

Every authenticated route calls `requirePermission(actor.user, '<perm>')`. Permissions are derived from a `role` claim (see SETUP.md). Key permission keys (`src/lib/constants.ts`): `leads.*`, `followups.manage`, `meetings.manage`, `customers.*`, `projects.manage`, `units.manage`, `bookings.*`, `cancellations.approve`, `documents.*`, `accounts.view`, `commissions.manage|approve`, `payouts.manage`, `reports.view`, `team.manage`, `integrations.manage`, `automation.manage`, `settings.manage`, `audit.view`. Unauthorized (but authenticated) calls return `403`.