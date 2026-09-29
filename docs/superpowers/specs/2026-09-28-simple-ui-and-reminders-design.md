# Simple Field UI + Reminder Engine — Design Spec

**Date:** 2026-09-28
**Status:** Approved (verbal sign-off, pending written review)
**Scope owner:** EstateFlow / SalesPoint CRM

---

## 1. Summary

Two features, built on infrastructure that already exists:

1. **A stripped-down UI** for field sales staff (`SALES_EXECUTIVE`) with four big
   actions instead of a 20-item sidebar. Every other role keeps today's UI
   byte-for-byte.
2. **A reminder engine** that emails the agent (never the customer) when a
   follow-up is overdue or a payment is past its due date, repeating daily until
   the agent acts.

The queue, the cron, the retry logic and the follow-up scheduling columns are all
already built. The work is the delivery channel, the daily scanner, and the
simple screens.

---

## 2. Goals

- A field agent can complete their whole day using four buttons and no training.
- An agent is told by email about every overdue follow-up and every unpaid due
  date, every day, until handled.
- API keys and tokens are editable from the UI by an admin, so nobody edits code
  or redeploys to change a provider key.
- Zero change to the existing manager/admin experience.

## 3. Non-goals (explicitly out of scope)

The user removed these from the first design pass. Do **not** build them:

- Accounts, commissions, payouts
- Bookings as a standalone feature
- Targets & forecast
- Meetings, site visits, loans, collections dashboards
- WhatsApp delivery
- Messaging customers at all — reminders are **agent-only**
- Multi-language / Hinglish UI (copy is plain English)

---

## 4. Decisions already made

| Decision | Outcome |
|---|---|
| Tone of the UI | Simple and professional, **not** cartoonish |
| Hide by role | Yes — `SALES_EXECUTIVE` only; others unchanged |
| Copy language | Plain simple English (`New Lead`, not `Prospect Onboarding`) |
| Agent's daily actions | Leads, follow-ups, payment collection, notifications |
| Payment-due reminder recipient | **The agent only** |
| Delivery channel | Email via Resend (one key) |
| Keys in UI | Yes, admin-only, encrypted at rest |

**Resolved ambiguity — the `bookings.bookingId` problem.**
`payments.bookingId` is `notNull` (`src/lib/db/schema.ts:413`), so a payment
cannot exist without a booking, and `SALES_EXECUTIVE` lacks `bookings.manage`.
Decision: the `/new-payment` flow will surface the customer's existing bookings
when one exists. If the customer has none, the flow creates a **draft booking**
automatically (a sale under negotiation) and links the payment to it. This keeps
the DB invariant satisfied without exposing a booking screen to the agent. The
agent never has to think about "bookings" as a concept.

---

## 5. Architecture

```
┌─ Field agent (SALES_EXECUTIVE) ──────────────┐
│  /home  /today  /new-lead  /my-leads  /new-payment │
│         EasyShell — 4 tiles, no sidebar       │
└───────────────┬────────────────────────────────┘
                │ reuses existing API routes
                ▼
┌─ Manager / Admin / everyone else ─────────────┐
│  existing (app)/ routes, AppShell sidebar      │
│  UNCHANGED                                     │
└────────────────────────────────────────────────┘

cron (*/5 * * * *) → /api/internal/process-queue
        │
        ├─ processDueJobs()      [exists, queue.ts:74]
        └─ scanReminders()       [NEW] → enqueue EMAIL jobs
                                        │
                                   EMAIL handler [NEW]
                                        │
                                   Resend HTTPS API
```

### 5.1 Why a separate route space

Next.js route groups do not create URL paths. Putting a second `page.tsx` at
`/leads` inside a new `(easy)` group would collide with the existing
`src/app/(app)/leads/page.tsx` and fail the build. The easy screens therefore get
**new, distinct URLs** that do not exist today:

| New URL | Purpose | Existing equivalent |
|---|---|---|
| `/home` | 4-tile home | — |
| `/today` | due + overdue follow-ups | `/followups` |
| `/new-lead` | 2-field lead capture | `/leads/new` |
| `/my-leads` | own leads as cards | `/leads` |
| `/new-payment` | record a due or received payment | `/collections` |

### 5.2 Where the role gate lives

`src/middleware.ts` runs on the Edge runtime and deliberately cannot touch the
database or `node:crypto` (see its header comment, lines 4–6). It can only check
that a session cookie exists. **The role gate must therefore live in the Node
runtime, in `src/app/(app)/layout.tsx`**, using the existing `getCurrentUser()`.

Behaviour:

- Role is `SALES_EXECUTIVE` → any `(app)` URL redirects to `/home`.
- Role is anything else → `/home` and the other easy URLs redirect to `/`.
- `/` itself becomes role-aware: `SALES_EXECUTIVE` → `/home`, others unchanged.

Server-side permission checks on API routes are unchanged and remain the real
authority. The redirect is a navigation convenience, not a security boundary.

---

## 6. Part A — The simple UI

### 6.1 EasyShell

`src/components/EasyShell.tsx`. Deliberately not a variant of `AppShell` — a
separate component, so `AppShell.tsx` needs no edits beyond the layout swap.

- No sidebar, no section labels, no search bar in the header.
- Header shows: greeting, notification bell (existing `/api/notifications`), and
  a gear linking to `/settings`.
- Body: the current page.
- On phone (`< lg`): a fixed bottom bar with the 4 tiles. On desktop: a 2×2 grid
  of large tiles filling the viewport.
- Minimum touch target 44px; primary action buttons 56px.
- Body text ≥ 16px. No hover-only affordances.

### 6.2 `/home` — the four tiles

Each tile: one large lucide icon, one word, one live count.

| Tile | Icon | Count source | Destination |
|---|---|---|---|
| Today | `PhoneCall` | follow-ups due today + overdue | `/today` |
| New Lead | `UserPlus` | — | `/new-lead` |
| Leads | `Users` | total non-closed leads owned by me | `/my-leads` |
| Money | `IndianRupee` | payment dues past due date | `/new-payment` |

All four counts come from **one** new read-only endpoint, `GET /api/easy/summary`,
rather than four separate calls.

### 6.3 The five screens

**`/today`** — list of due + overdue follow-ups. Each row: lead name, phone as a
`tele:` link, and three large buttons: **Call**, **Done**, **Later**. Overdue rows
are visually distinct (accent border) and sort first. No filters, no sorting UI,
no pagination controls.

**`/new-lead`** — exactly two inputs: Name and Phone. One large **Save** button.
A small secondary link "Add more details later" navigates to the existing
`/leads/{id}` page if the agent wants more. This works with zero backend change:
`createLeadSchema` requires only `name` (`src/lib/validators.ts:41`) — but note
its `.refine()` at lines 65–66 demands at least one of phone/email/whatsapp, so
**phone is effectively required in practice**. The simple form enforces that up
front rather than surfacing a server error.

**`/my-leads`** — cards, never a table. Each card: name, status as a coloured
pill, and a Call button. Two filter chips only: **All** and **Booked**.

**`/new-payment`** — three steps, one per screen, with a persistent large
primary button:
1. Who is paying — pick a customer from own leads/customers, or type a name.
2. How much and by when — Amount, Due date (today by default), and two buttons:
   **Got the money** / **Will pay later**.
3. Confirmation — a large green *"₹80,000 noted ✓"*.

  - **Will pay later** inserts a `PENDING` row in the new `payment_due` table.
  - **Got the money** inserts a `RECEIVED` row in `payments`, and additionally
    closes any matching `PENDING` `payment_due` row.

**`/settings/keys`** — see Part B.

### 6.4 What the easy UI deliberately excludes

No filter row, no column pickers, no CSV export, no pagination widgets, no
empty-state illustrations with jargon, no bulk actions, no inline editing of
status text. If an agent needs something not on these five screens, the gear icon
links to the full CRM.

---

## 7. Part B — Managing keys from the UI

### 7.1 Storage

Reuse the existing `integrations` table (`src/lib/db/schema.ts:640`), which
already has `provider` (unique), `config` (jsonb), `isActive`, and `updatedAt`.
No new table is needed.

Row shape:

```
provider: 'resend'
label:    'Resend (email)'
isActive: true
config:   { apiKey: <encrypted>, fromEmail, fromName }
```

### 7.2 Encryption

`apiKey` is encrypted with **AES-256-GCM** before being written to the jsonb.
The 32-byte master key comes from the `SETTINGS_ENCRYPTION_KEY` env var and is
never exposed to, or settable from, the browser. Stored value is
`v1:<iv>:<authTag>:<ciphertext>`, all base64.

`src/lib/secrets.ts` exposes exactly two operations: `encryptSecret` and
`decryptSecret`. Nothing else in the app decrypts.

**Fallback:** if no `resend` integration row is active, the sender reads
`RESEND_API_KEY` from the environment. This keeps the current deployment working
during rollout and lets the UI be adopted later without downtime.

### 7.3 Access and secrecy

- Page requires `integrations.manage` — held only by `ADMIN` and `SUPER_ADMIN`.
  `SALES_EXECUTIVE` does not have it (`src/lib/constants.ts:377`–`387`).
- The API returns only a masked hint (`re_abc••••••••9x2k`), never the full key,
  on every read including after save.
- Writes and reads of real keys write an `audit_logs` row
  (`src/lib/db/schema.ts:652`) with the user, provider and timestamp. The secret
  itself is **never** written to `audit_logs`, to avoid duplicating it in a place
  that is easier to read.
- The only time a full key is ever returned is immediately after a save, to the
  requester who just typed it, as a one-time display. Even this is skipped by
  default: the response echoes only the mask.

---

## 8. Part C — The reminder engine

### 8.1 New table: `payment_due`

This is the missing concept. `payments` records money that has *already* been
received (`paymentDate`, `status: RECEIVED`, `src/lib/db/schema.ts:411`–`433`);
there is no place to record "customer said tomorrow". A new table holds the
expectation.

```
payment_due
  id            text pk
  leadId        -> leads        (set null on delete)
  customerId    -> customers    (set null on delete)
  bookingId     -> bookings     (set null on delete; auto-created draft if absent)
  amount        money, not null
  dueDate       timestamptz, not null      -- the date the customer promised
  status        PENDING | PAID | CANCELLED, default PENDING
  paidAt        timestamptz
  paymentId     -> payments     (set when the money actually arrives)
  paidAmount    money          -- may differ from amount after part payment
  notes         text
  createdById   -> users
  createdAt / updatedAt

indexes: (status, dueDate), (customerId), (leadId)
```

A `payment_due` row marked `PAID` is never deleted — it is the audit trail of the
promise, which is what the reminder email quotes.

### 8.2 The daily scanner

`scanReminders()` in `src/lib/reminders.ts`, called from
`/api/internal/process-queue` after `processDueJobs()`. The cron already runs
every five minutes (`vercel.json`), so the scanner is time-gated internally
rather than needing a second cron entry.

Two queries:

1. **Overdue follow-ups** — `followups` where `status = 'PENDING'` and
   `scheduledAt < now()`, grouped by `assignedTo`. The `followups` table already
   has `scheduledAt`, `status` and `assignedTo`
   (`src/lib/db/schema.ts:292`–`316`).
2. **Overdue payment dues** — `payment_due` where `status = 'PENDING'` and
   `dueDate <= today`, grouped by owner. The two candidate columns are
   `leads.assignedTo` (`src/lib/db/schema.ts:341`) and `customers.ownerId` —
   note the name, it is **not** `assignedTo`. Fall back to `createdById` when
   neither is set, so a row is never silently dropped from every digest.

**Indexing.** `idx_followups_assigned` on `followups.assignedTo`
(`src/lib/db/schema.ts:315`) and `idx_customers_owner` on `customers.ownerId`
already exist, so the grouping is index-supported. The overdue *filter* also
needs `status` and `scheduledAt`, which no existing index covers. The migration
should add a partial index on `(status, scheduledAt) WHERE status = 'PENDING'`,
so the daily scan does not table-scan an ever-growing table.

Then, per agent:

- Skip agents whose `users.remindersEnabled` is false.
- Build **one digest** per agent, not one email per item. An agent with 20
  overdue follow-ups receives a single email listing all 20. Per-item emails
  would be spam and would burn the Resend quota.
- Enqueue one `EMAIL` job per agent with `runAt` set to the next 09:00 IST
  (default; overridden by `users.reminderTime`).
- **Idempotency:** a `digest_key` column on `background_jobs` is set to
  `overdue:{agentId}:{yyyy-mm-dd}`. The scanner skips an agent whose key already
  exists for today, so re-running the cron (every 5 min) can never send twice.

This satisfies "keep notifying me until I do the follow-up": the row stays
`PENDING`, so tomorrow's scan finds it again, and the digest key differs by date.

### 8.3 The `EMAIL` job handler

`EMAIL` is already a declared `JobType` (`src/lib/queue.ts:5`) but no handler is
registered — only `REMINDER` and `NOTIFY`
(`src/lib/notifications.ts:69`–`87`). Registering one completes the plumbing.

`registerEmailHandler()`:

1. `decryptSecret` the key (or fall back to `RESEND_API_KEY`).
2. `POST https://api.resend.com/emails` with **plain `fetch`**. No new npm
   dependency is added.
3. On non-2xx, throw so the existing retry logic in `withRetry`
   (`src/lib/queue.ts:56`) retries up to `maxAttempts`, then marks the job
   `FAILED` with `lastError` for the admin diagnostics panel.

Registration follows the existing lazy pattern in `notifications.ts` (dynamic
`import('./queue')` inside an async function) so the handler map is populated
before `processDueJobs` looks up `handlers.get(job.type)`
(`src/lib/queue.ts:84`).

### 8.4 Email content

Plain text plus a simple HTML table. Subject:

- `You have 3 follow-ups pending`
- `Payment due: Ramesh Sharma - ₹80,000`

Body lists name, phone, how late, and a link back to `/today` or
`/new-payment`. No attachments, no images — the Resend free tier is
3,000 emails/month and every attachment costs bandwidth.

### 8.5 Delivery window and volume

At most one digest per agent per day, ~150 words. With 20 agents that is
600 emails/month — comfortably inside the free tier.

---

## 9. Permission changes (required)

This is the one place where the change is not purely additive, and it needs to be
called out.

`SALES_EXECUTIVE` currently has `collections.view` but **not**
`collections.manage` (`src/lib/constants.ts:385`), so today a field agent
*cannot* record a payment — they can only look. Making `/new-payment` work
requires adding:

| Permission | Why |
|---|---|
| `collections.manage` | To record a payment. **This is the real grant.** |
| `bookings.manage` | Only for the server-side auto-creation of a draft booking. Never used by the agent directly. |

Risk: `collections.manage` also allows editing existing collection records. If
that is too broad, the alternative is a narrower new permission such as
`payments.record`, checked only by the `/api/easy/payment` route. **Recommend the
narrow permission** to keep blast radius small; the auto-created draft booking
can be created by a service-layer function that bypasses role checks, so
`bookings.manage` does not need to be granted to the role at all.

Reminders are sent by a background job, not by a user action, so no permission
is required for agents to receive them.

Whichever option is chosen, `src/lib/constants.ts` needs editing.
`Permission` is a literal string union beginning at line 293, so a new
`payments.record` member must be added there *and* to
`ROLE_PERMISSIONS.SALES_EXECUTIVE` (line 377). Granting only the existing
`collections.manage` needs just the second edit.

---

## 10. Configuration required

| Variable | Required? | Purpose |
|---|---|---|
| `RESEND_API_KEY` | Yes, unless the key is set in the UI | Resend API key. UI takes precedence. |
| `SETTINGS_ENCRYPTION_KEY` | Yes | 32-byte hex master key for encrypting stored keys |
| `APP_TIMEZONE` | Yes | Digest "today" and 09:00 IST must be computed in the right zone |

`CRON_SECRET` is already set and must stay set — the reminder scanner runs
behind it, and an unset value fails the route closed
(`src/app/api/internal/process-queue/route.ts:16`–`21`).

The user supplies only the Resend key. The other two are generated during
implementation and placed in `.env` and `.env.example`.

---

## 11. Error handling

| Failure | Behaviour |
|---|---|
| Resend key missing | Job fails with `lastError = 'Resend not configured'`; shown on a `/settings/keys` status banner. No email, no crash, scanner keeps working. |
| Resend returns 4xx/5xx | Throw; existing `withRetry` retries; after `maxAttempts` the job is `FAILED` with the error text. |
| Agent has no email | Skipped, logged to `lastError` on the job rather than retried forever. |
| Reminders disabled for agent | Scanner skips before enqueueing, so no job is created. |
| `SETTINGS_ENCRYPTION_KEY` missing | Key writes are rejected with a clear error. Existing unencrypted env fallback still sends mail. |
| Scanner query fails | Caught and logged; `processDueJobs` still runs first and independently, so no other queued work is lost. |

Nothing in the notification path may throw into a user-facing request. Both
`enqueueJob` and the in-app `notifyUser` are already best-effort by design.

---

## 12. Security

- **No secret ever reaches the browser in full.** Reads return a mask only.
- **No secret is logged.** `lastError` and `audit_logs` must never contain a key.
  Audit rows record the provider and the fact of the change, not the value.
- **Edge middleware does not gate the easy routes by role** — it cannot. The
  Node layout redirect is UX only. API routes keep enforcing permissions
  server-side, which is the actual boundary.
- **The cron route stays closed** when `CRON_SECRET` is unset.
- The stored key is encrypted with GCM, so a database dump without
  `SETTINGS_ENCRYPTION_KEY` yields no usable credentials.
- Reminders contain customer names, phone numbers and amounts. They go to the
  agent's own registered email only, never to a customer address — the To header
  is the agent, with customer details only in the body.

---

## 13. Testing

Follow the existing 10-file / 193-test setup.

**Unit**
- `secrets.ts`: encrypt→decrypt round trip; wrong key throws; malformed stored
  value throws; no plaintext appears in the ciphertext.
- Digest builder: groups by agent, sorts overdue first, caps the list, renders
  the mask correctly.
- `digest_key` idempotency: scanning twice on the same day enqueues once.

**Integration**
- Scanner finds a `PENDING` follow-up with `scheduledAt` in the past and enqueues
  for the assignee.
- Scanner does **not** enqueue for a `DONE` follow-up or a `PAID` `payment_due`.
- `payment_due` with `dueDate = today` is included; tomorrow's date is not.
- `EMAIL` handler marks a job `DONE` on 200 and `FAILED` after max attempts on
  repeated 500s, with a mock `fetch`.
- `GET /api/easy/summary` returns the four counts and requires a session.

**Route guards**
- `SALES_EXECUTIVE` hitting `/leads` is redirected to `/home`.
- `ADMIN` hitting `/home` is redirected to `/`.
- `SALES_EXECUTIVE` hitting `/settings/keys` is denied.
- API responses for keys contain no full secret substring.

**Regression — the important one**
- Existing 193 tests must pass unchanged. If any need editing, that is a signal
  the manager path changed and the change must be reverted.

---

## 14. Rollout

1. Migration adding the `payment_due` table and `users.remindersEnabled` /
   `users.reminderTime`. Additive only; no existing table is altered.
2. Backend: `secrets.ts`, `reminders.ts`, `EMAIL` handler, `/api/easy/summary`,
   `/api/easy/payment`, `/settings/keys` API. Guarded by the flag
   `SIMPLE_UI_ENABLED` (default off).
3. Frontend: `(easy)` route group and `EasyShell`, still behind the flag.
4. Turn the flag on for a pilot, or promote one `SALES_EXECUTIVE` user.
5. Admin sets the Resend key at `/settings/keys` and sends a test email.

Rollback is flipping the flag; the `(app)` UI is untouched throughout.

---

## 15. Open items

None outstanding. The two questions raised during design — payment reminder
recipient, and delivery channel — were answered by the user, and the
`bookings.bookingId` ambiguity is resolved in §4.
