# Setup

Prerequisites: Node 18.18+ (LTS 20 recommended), npm, a Neon (PostgreSQL) project, and (optionally) a Cloudflare R2 bucket.

There is no external identity provider. Passwords are hashed with scrypt and stored in `users.password_hash`; sessions are opaque tokens stored in the `sessions` table, so **no auth secrets are needed**.

## 1. Environment variables

Copy `.env.example` to `.env` and fill in:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon pooled connection string, e.g. `postgresql://user:pass@ep-xxx-pooler.us-east-2.aws.neon.tech/dbname?sslmode=require`. `require`/`prefer`/`verify-ca` are all treated as `verify-full` by the runtime (ddl/pg note). |
| `AUTH_DEMO_MODE` | `"true"` bypasses password auth and signs you in as the seeded `demo` SUPER_ADMIN user. **Must be `false` in production.** |
| `SESSION_TTL_DAYS` | Session lifetime in days (default `7`). |
| `APP_BASE_URL` | Public URL of the app (e.g. `http://localhost:3000`). |
| `R2_*` / `LOCAL_STORAGE_DIR` | Object storage. Leave `R2_*` empty to use the local-disk fallback (dev only). |
| `WEBHOOK_SECRET` | Shared secret checked on `/api/webhooks/leads` via the `x-webhook-secret` header. |

### Demo mode seeds

`npm run db:seed` always upserts a `demo` SUPER_ADMIN user (`id = 'demo'`). Writes by the demo actor respect foreign keys because this row exists.

## 2. Database (Neon)

```bash
npm run db:migrate         # applies schema; safe to re-run (idempotent constraints)
npm run db:ensure-admin    # create the bootstrap super-admin (idempotent)
npm run db:seed            # optional demo dataset (destructive: wipes seeded data first)
npm run db:push            # (optional) push schema diff via drizzle-kit
```

The migration files live in `drizzle/`. Check constraints (status enums, source whitelist, money checks) are re-applied with `IF NOT EXISTS` so repeat runs never fail.

## 3. Creating the first user

There is no signup form for admins, so bootstrap the first account directly:

```bash
npm run db:ensure-admin
```

This creates `crm@gmail.com` with password `crm123` and role `SUPER_ADMIN`. It is idempotent: re-running it leaves an existing account alone rather than resetting its password, and it repairs a row that has no password set yet.

> **Change this password before exposing the app.** `crm123` is a fixed, well-known value. It is rejected by the signup policy, so nobody else can choose it, but the bootstrap account itself must be changed.

Everyone else signs up at `/signup` and receives the `SALES_EXECUTIVE` role. Roles are assigned in the database by an existing admin; self-service signup can never choose a role.

Valid roles: `SUPER_ADMIN`, `ADMIN`, `SALES_MANAGER`, `TEAM_LEADER`, `SALES_EXECUTIVE`.

## 4. How sign-in works

- `POST /api/auth/login` verifies the password with scrypt and sets an `httpOnly`, `SameSite=Lax` cookie named `sp_session`.
- Only a SHA-256 hash of the session token is stored, so a database leak cannot be replayed as a login.
- `middleware.ts` does a cheap cookie-presence check and redirects to `/login`; every API route independently resolves the session and returns `401` if it is missing or expired.
- `POST /api/auth/logout` deletes the session row and clears the cookie.
- Passwords must be at least 8 characters and contain both a letter and a number.

## 5. Object storage

- **Cloudflare R2**: create a bucket (private), generate an access key with `Object Read & Write` on that bucket. Set `R2_ENDPOINT` (`https://<accountid>.r2.cloudflarestorage.com`), `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`. Keep `R2_PUBLIC_URL` empty — downloads are served through the authenticated proxy `/api/documents/file/[id]`.
- **Local fallback** (dev): leave R2 vars blank; files land in `LOCAL_STORAGE_DIR` (default `.local-storage`, git-ignored).

## 6. Webhooks / integrations (optional)

- Configure your source (Meta, WhatsApp, MagicBricks, 9/99acres…) to POST leads to `/api/webhooks/leads` with header `x-webhook-secret: <WEBHOOK_SECRET>`. Payloads are validated, persisted to `incoming_leads`, then imported as leads with source `WEBSITE` (extend `src/lib/services/leads.ts` per provider if needed).
- Ad-account link: FB / IG / WhatsApp / MagicBricks tokens can be stored via the Settings UI (integration keys) and consumed by automation.

## 7. Run

```bash
npm run dev        # development
npm test           # unit tests
npm run build && npm start -- -p 3000
```

With the server running, `npm run verify` signs in and exercises every API route
and page. Add `VERIFY_SIGNUP=1` to also test the signup flow — that creates real
user rows, so it is opt-in.
