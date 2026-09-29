# Deployment

## Verifiable build

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

`next build` must complete with the full route table printed, and must print **no** errors from `src/`. (The `node:crypto` import in `src/lib/password.ts` is server-only — never import it from a client component, or the build fails with `UnhandledSchemeError`. Client-safe policy constants live in `src/lib/password-policy.ts`.)

**Note for production `next start`:** starting the app in dev mode (`next dev`) overwrites `.next` and removes `BUILD_ID`. Always run `npm run build` again before `next start`, and point any health check at `/api/health`.

## Hosting options

- **Serverless platform** (Vercel / Cloudflare Workers): set `npm run build` as build command, `next start` as start command. Node runtime is enforced per route (`export const runtime = 'nodejs'`).
- **VPS / container**:

```bash
npm ci --omit=dev                       # prod deps only
npm run build
node node_modules/next/dist/bin/next start -p 3000
```

Run behind a reverse proxy (Caddy/Nginx) with HTTPS. `APP_BASE_URL` must match the public origin.

## Environment checklist (staging/production)

- [ ] `AUTH_DEMO_MODE="false"` — never true in production
- [ ] `SESSION_TTL_DAYS` set to a sensible lifetime (default `7`)
- [ ] `CRON_SECRET` set (32 random bytes, e.g. `openssl rand -hex 32`) — the job queue fails closed without it
- [ ] `DATABASE_URL` points at the production Neon (pooled) endpoint
- [ ] `R2_*` configured (document storage won't persist on local disk across instances)
- [ ] `WEBHOOK_SECRET` set *or* configured from Settings → Go-live checklist → Webhook secret (UI-set value wins; the env var is only a fallback). Documented in the provider's integration console
- [ ] `SETTINGS_ENCRYPTION_KEY` set (32 bytes, e.g. `openssl rand -hex 32`) — required by Settings → Email keys; without it `PUT /api/settings/keys` returns `503` and nothing is stored
- [ ] `RESEND_API_KEY` **or** a key saved in Settings → Email keys, if reminder digests are wanted
- [ ] `APP_TIMEZONE` matches the business timezone, *or* set from Settings → Go-live checklist → Timezone (defaults to `Asia/Kolkata`)
- [ ] `SIMPLE_UI_ENABLED` deliberately set — it is `"false"` by default
- [ ] `.env` is NOT in git (see `.gitignore`)
- [ ] `NODE_ENV=production`

## Multi-instance (white-label / Option A)

Selling the same CRM to several places on one codebase: **one deployment per client**, each with its own database and env. The only config that must be in the environment is the bootstrap that the database itself cannot hold:

| Env-only (bootstrap) | Why it cannot be a UI setting |
| --- | --- |
| `DATABASE_URL` | Settings live *in* the database — there is no place to store where the database is |
| `SETTINGS_ENCRYPTION_KEY` | Master key for UI-saved secrets; storing it next to the ciphertext defeats the encryption |
| `CRON_SECRET` | Guards `/api/internal/process-queue`; must be set before the queue can run |

Everything else — Meta/Facebook tokens, Resend key, sender address, lead webhook secret, timezone — is managed from the UI per instance.

Provision a new instance in one command:

```bash
npm run provision:instance   # writes .env.instance with generated keys
```

It prompts for the `DATABASE_URL` and instance name, generates `SETTINGS_ENCRYPTION_KEY` and `CRON_SECRET`, and prints the next steps:

1. Copy `.env.instance` into the host's env (e.g. `cp .env.instance .env.local`)
2. `npm run db:migrate`
3. `npm run db:ensure-admin -- <admin-email>`
4. Start the app, sign in, then finish setup from the **Settings → Go-live checklist** (webhook secret, timezone) and **Settings → Email keys / Keys** (Resend + Meta).

A failed boot almost always means one of the bootstrap values is missing; the checklist card turns from amber to green as each part is configured. Per-instance optional env values (`EMAIL_FROM`, `EMAIL_FROM_NAME`, `APP_TIMEZONE`, `SIMPLE_UI_ENABLED`) are accepted by the script but never required.

## Reminder digests

One email per agent per local day summarises that agent's overdue follow-ups and
outstanding payment dues. It is queued by the same `/api/internal/process-queue`
scan described above and sent at 09:00 in `APP_TIMEZONE`, so no extra cron entry
is needed — the existing 5-minute schedule picks it up. Re-running the scan on the
same day is a no-op per agent, because each digest carries a
`reminder-digest:<agentId>:<localDate>` key.

Delivery is skipped entirely when no credential is configured, so reminders
cannot fail the queue. The resolver prefers a key stored (AES-256-GCM encrypted)
in the `integrations` table and falls back to the `RESEND_API_KEY` env var.
`RESEND_FROM_EMAIL` must be a verified Resend sender; leave the from-name blank to
let Resend default it.

Rotating `SETTINGS_ENCRYPTION_KEY` makes every stored secret unreadable — re-save
them from Settings → Email keys afterwards.

## Simple UI

`SIMPLE_UI_ENABLED="true"` opts `SALES_EXECUTIVE` into the phone-first flow at
`/home`, `/today`, `/new-lead`, `/my-leads` and `/new-payment`, and redirects
that role away from `/` to `/home`. Other roles are unaffected, and the flag is
`"false"` by default, so deploying without setting it changes nothing.

## Before going live

- [ ] `npm run db:migrate` has been run against the production database
- [ ] `npm run db:ensure-admin` has created the first super-admin
- [ ] The bootstrap password has been **changed** — `crm123` is a fixed, well-known value. It is rejected by signup policy, so nobody else can pick it, but the bootstrap account itself must be changed.
- [ ] `npm run verify` passes against the deployed origin

## Scheduled jobs

Jobs are persisted in the `background_jobs` table, but there is no in-process worker — nothing
drains them on its own. A scheduler must call the internal job endpoint on a timer (every 5 minutes):

```
GET/POST /api/internal/process-queue
```

This processes due follow-up automation/reminder jobs (max 25 per invocation). The route authenticates itself with a shared secret and **fails closed**: it requires

```
Authorization: Bearer $CRON_SECRET
```

and returns `403` if `CRON_SECRET` is unset or the header does not match. Set the secret in the platform's env vars and configure the cron there; the secret is supplied automatically by Vercel Cron. A `403` in the cron logs almost always means `CRON_SECRET` is missing from the deployment, and the symptom is that scheduled jobs silently stop running.

`vercel.json` already declares the schedule:

```json
{ "crons": [{ "path": "/api/internal/process-queue", "schedule": "*/5 * * * *" }] }
```

On other platforms (VPS, container) point cron at the URL yourself, e.g. `*/5 * * * * curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://your-host/api/internal/process-queue`.

## Security notes

- **RBAC** — every route enforces `requirePermission(actor.user, '<perm>')` on top of authentication. Permission keys live in `src/lib/constants.ts` (`ROLE_PERMISSIONS`).
- **Status machine** — terminal lead statuses (`DEAL_COMPLETED`, `CANCELLED`, `DUPLICATE`) require an admin override to reopen; enforced in `statusMachine.ts` and the service layer.
- **Money integrity** — commissions are snapshots (immutable); versioned rules never mutate history; reversals write adjustments + ledger debits; bookings lock the unit row with `SELECT ... FOR UPDATE` inside a transaction.
- **Documents** — the upload route parses `multipart/form-data` and validates size (50 MB cap) and MIME allowlist in `src/lib/services/documents.ts`; downloads go through the authenticated proxy, never a public presigned URL while the bucket is private.
- **Passwords** — hashed with scrypt (`N=16384, r=8, p=1`, 16-byte random salt) and compared with `timingSafeEqual`. The cost parameters are stored inside each digest, so they can be raised later without invalidating existing passwords. Accounts with no password set (e.g. rows migrated from a previous SSO setup) burn equivalent CPU on login, so "no such user" is not distinguishable by timing.
- **Sessions** — 256-bit opaque tokens. Only a SHA-256 hash is stored, so a database dump cannot be replayed as a login. The cookie is `httpOnly` + `SameSite=Lax`, and `Secure` is set automatically when the request is over HTTPS. `middleware.ts` only does a cheap cookie-presence check, so authorization is always re-verified server-side in the route handler.
- **Secrets** — never log `DATABASE_URL`, `R2_*` or webhook secrets; they exist only in `.env` / platform env vars. There are no auth secrets to rotate.

## Rollbacks

- DB migrations are idempotent (`IF NOT EXISTS`) so re-deploying the same release is safe.
- Snapshot-based commissioning means `reversePayoutTx` can claw back a payment even after finalization.