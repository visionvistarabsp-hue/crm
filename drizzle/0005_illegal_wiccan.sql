CREATE TABLE "payment_due" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text,
	"customer_id" text,
	"booking_id" text,
	"amount" numeric(14, 2) NOT NULL,
	"due_date" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"paid_at" timestamp with time zone,
	"payment_id" text,
	"paid_amount" numeric(14, 2),
	"notes" text,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "background_jobs" ADD COLUMN "digest_key" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "reminders_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "reminder_time" text DEFAULT '09:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_due" ADD CONSTRAINT "payment_due_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_due" ADD CONSTRAINT "payment_due_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_due" ADD CONSTRAINT "payment_due_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_due" ADD CONSTRAINT "payment_due_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_due" ADD CONSTRAINT "payment_due_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_payment_due_status" ON "payment_due" USING btree ("status","due_date");--> statement-breakpoint
CREATE INDEX "idx_payment_due_customer" ON "payment_due" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "idx_payment_due_lead" ON "payment_due" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "idx_payment_due_booking" ON "payment_due" USING btree ("booking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_jobs_digest_key" ON "background_jobs" USING btree ("digest_key");--> statement-breakpoint
CREATE INDEX "idx_followups_status_scheduled" ON "followups" USING btree ("status","scheduled_at");