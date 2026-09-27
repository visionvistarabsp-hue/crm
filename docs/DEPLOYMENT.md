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
- [ ] `APP_BASE_URL` = real public URL
- [ ] `SESSION_TTL_DAYS` set to a sensible lifetime (default `7`)
- [ ] `DATABASE_URL` points at the production Neon (pooled) endpoint
- [ ] `R2_*` configured (document storage won't persist on local disk across instances)
- [ ] `WEBHOOK_SECRET` set; documented in the provider's integration console
- [ ] `.env` is NOT in git (see `.gitignore`)
- [ ] `NODE_ENV=production`

## Before going live

- [ ] `npm run db:migrate` has been run against the production database
- [ ] `npm run db:ensure-admin` has created the first super-admin
- [ ] The bootstrap password has been **changed** — `crm123` is a fixed, well-known value. It is rejected by signup policy, so nobody else can pick it, but the bootstrap account itself must be changed.
- [ ] `npm run verify` passes against the deployed origin

## Scheduled jobs

The app has no persistent queue — a scheduler must call the internal job endpoint on a timer (e.g. every 5 minutes):

```
GET/POST /api/internal/process-queue
```

This processes due follow-up automation/reminder jobs (max 25 per invocation). Configure it with cron in your hosting provider; block public access with middleware (the path is whitelisted but callers should still only come from your platform).

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