ALTER TABLE "leads" ADD COLUMN "first_touched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "escalated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "new_lead_alerts_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_leads_unclaimed" ON "leads" USING btree ("created_at") WHERE "leads"."status" = 'NEW' AND "leads"."first_touched_at" IS NULL AND "leads"."escalated_at" IS NULL;