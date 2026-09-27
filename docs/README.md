# EstateFlow CRM

A production-ready **Real Estate Sales CRM** built with Next.js 15 (App Router), TypeScript, Tailwind CSS, PostgreSQL (Neon), Drizzle ORM and Cloudflare R2.

Manage the full sales lifecycle: lead intake → follow-ups & meetings → inventory → bookings → payments → cancellations & refunds → commissions & payouts → reports.

---

## Feature map

| Area | Capabilities |
|---|---|
| **Leads** | Multi-source intake (Instagram, Facebook, WhatsApp, YouTube Ads, 9/99acres, MagicBricks, website, referral), status machine, ownership & round-robin assignment, activities & status history, duplicate detection & resolution, bulk CSV export |
| **Follow-ups / Meetings** | Schedule, reschedule, complete, today/upcoming/overdue views, calendar-less scheduling with due-date engine |
| **Customers** | Central profile, auto-created from bookings, linked documents |
| **Inventory** | Projects, towers, auto-generated units, hold/release, status tracking (available / hold / booked) |
| **Bookings** | Unit locking (row lock), payment schedule, deposit, statuses (CONFIRMED / CANCELLED), payment receipts, ledger |
| **Cancellations / Refunds** | Request → approval workflow, auto inventory release, auto refund, commission reversal |
| **Commissions** | Rule engine (fixed / percentage / sale-value / collection-based / slab), versioned rules, immutable snapshots, approve → payable → paid, adjustments & ledger |
| **Payouts** | Batch creation, process (mark payable pending → in-progress), finalize, transaction reversal |
| **Documents** | Multipart upload to R2 or local disk, private signed/authenticated downloads, types (agreement, receipt, ID, offer), verify workflow |
| **Reports & Analytics** | Sales report (by user/project/status), cancellations report, dashboard KPIs (bookings, sale value, commissions, trend) |
| **Operations** | Global search, notifications, settings key/value store, automation rules (auto follow-up creation), audit log, team management, integration keys |
| **Platform** | Database-backed email/password auth + RBAC, REST JSON API, webhook receiver, background job endpoint, demo mode |

## Tech stack

- **Framework** – Next.js 15.5 (App Router, React 19, Server Actions not used — REST API)
- **Database** – PostgreSQL (Neon) via `pg`, schema & queries through Drizzle ORM 0.38
- **Auth** – self-hosted email/password (scrypt via `node:crypto`) with opaque DB sessions, optional `AUTH_DEMO_MODE` bypass. No external identity provider and no auth secrets.
- **Storage** – `@aws-sdk/client-s3` against Cloudflare R2 (S3-compatible), local-disk fallback
- **Validation** – Zod
- **UI** – Tailwind CSS, Radix UI (dialog/dropdown/checkbox/tabs), lucide-react icons, recharts
- **Testing** – Vitest (unit), ESLint (next/core-web-vitals), `tsc --noEmit`

## Quick start

```bash
npm install
cp .env.example .env        # fill in real values (see docs/SETUP.md)
npm run db:migrate          # apply schema + constraints (idempotent)
npm run db:seed             # demo data incl. demo SUPER_ADMIN user
npm run dev                 # http://localhost:3000
```

With `AUTH_DEMO_MODE=true` you are automatically signed in as the seeded `Demo Admin` (SUPER_ADMIN) — no login required.

## Validation

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # next lint (deprecation notice only)
npm run test         # vitest run (pure logic: status machine, commissions, duplicates)
npm run build        # production build
```

## Project layout

```
src/
├─ app/
│  ├─ api/                    # REST endpoints (module-scoped folders)
│  ├─ (app)/                  # authenticated UI pages (AppShell layout)
│  ├─ login/                  # demo-mode auto-login page
│  ├─ layout.tsx              # root layout
│  └─ globals.css             # Tailwind + component classes
├─ components/                # UI kit + AppShell
├─ lib/
│  ├─ api.ts                  # requireUser / requirePermission / ApiError
│  ├─ handlers.ts             # withApi / withPublic / param route wrappers
│  ├─ services/               # business logic per domain
│  ├─ db/                     # schema, constraints, migrations, seed
│  ├─ validators.ts           # zod schemas
│  └─ storage/                # R2 / local storage adapter
└─ tests/                     # Vitest unit tests
```

## Documentation

- [Setup guide](docs/SETUP.md) — environment, Neon, local auth, R2
- [Deployment](docs/DEPLOYMENT.md) — build, background jobs, security checklist
- [API reference](docs/API.md) — every endpoint