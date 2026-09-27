import { sql } from 'drizzle-orm';
import { db } from './index';

/**
 * Idempotent complement to Drizzle migrations. Adds CHECK constraints for
 * domain enums that are modelled as text columns. Runs safely on every
 * `db:migrate` invocation.
 */
export const CONSTRAINTS: Array<{ name: string; table: string; check: string }> = [
  {
    name: 'chk_leads_status',
    table: 'leads',
    check: "status IN ('NEW','CONTACT_PENDING','CONTACTED','QUALIFIED','FOLLOW_UP','MEETING','SITE_VISIT_1','SITE_VISIT_2','SITE_VISIT_3','NEGOTIATION','BOOKING','DOCUMENT_COLLECTION','DEAL_COMPLETED','NOT_INTERESTED','CALL_BACK_LATER','WRONG_NUMBER','DUPLICATE','LOST','CANCELLED')",
  },
  {
    name: 'chk_leads_source',
    table: 'leads',
    check: "source IN ('INSTAGRAM','FACEBOOK','WHATSAPP','NINE9ACRES','REALESTATE_INDIA','MAGICBRICKS','YOUTUBE_ADS','WEBSITE','REFERRAL','MANUAL')",
  },
  {
    name: 'chk_leads_priority',
    table: 'leads',
    check: "priority IN ('LOW','MEDIUM','HIGH','URGENT')",
  },
  {
    name: 'chk_units_status',
    table: 'units',
    check: "status IN ('AVAILABLE','HOLD','BOOKED','SOLD','CANCELLED')",
  },
  {
    name: 'chk_projects_status',
    table: 'projects',
    check: "status IN ('DRAFT','ACTIVE','ON_HOLD','COMPLETED')",
  },
  {
    name: 'chk_bookings_status',
    table: 'bookings',
    check: "status IN ('DRAFT','CONFIRMED','DOCUMENT_COLLECTION','COMPLETED','CANCELLED')",
  },
  {
    name: 'chk_followups_status',
    table: 'followups',
    check: "status IN ('PENDING','COMPLETED','SKIPPED','EXPIRED')",
  },
  {
    name: 'chk_meetings_status',
    table: 'meetings',
    check: "status IN ('SCHEDULED','CONFIRMED','COMPLETED','RESCHEDULED','CANCELLED','NO_SHOW')",
  },
  {
    name: 'chk_documents_status',
    table: 'documents',
    check: "verification_status IN ('PENDING','VERIFIED','REJECTED','RE_UPLOAD')",
  },
  {
    name: 'chk_users_role',
    table: 'users',
    check: "role IN ('SUPER_ADMIN','ADMIN','SALES_MANAGER','TEAM_LEADER','SALES_EXECUTIVE','DOCUMENT_MANAGER','ACCOUNTS','VIEW_ONLY')",
  },
];

export async function applyConstraints(): Promise<void> {
  for (const c of CONSTRAINTS) {
    await db.execute(sql.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = '${c.name}'
        ) THEN
          ALTER TABLE "${c.table}" ADD CONSTRAINT "${c.name}" CHECK (${c.check});
        END IF;
      END $$;
    `));
  }
  // Self-referencing FK for users.manager_id (moved out of the schema to
  // keep TS inference on the `users` table intact).
  await db.execute(sql.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_users_manager'
      ) THEN
        ALTER TABLE users
          ADD CONSTRAINT fk_users_manager
          FOREIGN KEY (manager_id) REFERENCES users(id) ON DELETE SET NULL;
      END IF;
    END $$;
  `));
}