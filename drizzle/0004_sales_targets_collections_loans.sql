CREATE TABLE "loans" (
	"id" text PRIMARY KEY NOT NULL,
	"booking_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"applicant_name" text,
	"applicant_relation" text,
	"bank_name" text,
	"application_no" text,
	"loan_type" text DEFAULT 'HOME' NOT NULL,
	"loan_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"margin_amount" numeric(14, 2),
	"property_valuation" numeric(14, 2),
	"interest_rate" numeric(5, 3),
	"tenure_months" integer,
	"emi" numeric(14, 2),
	"status" text DEFAULT 'APPLIED' NOT NULL,
	"application_date" timestamp with time zone NOT NULL,
	"sanction_date" timestamp with time zone,
	"disbursement_date" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"remarks" text,
	"meta" jsonb DEFAULT '{}'::jsonb,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_milestones" (
	"id" text PRIMARY KEY NOT NULL,
	"booking_id" text NOT NULL,
	"seq" integer NOT NULL,
	"name" text NOT NULL,
	"due_date" timestamp with time zone NOT NULL,
	"percentage" numeric(6, 3),
	"amount" numeric(14, 2) NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"paid_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"paid_at" timestamp with time zone,
	"notes" text,
	"meta" jsonb DEFAULT '{}'::jsonb,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"period" text NOT NULL,
	"project_id" text,
	"booking_value_target" numeric(14, 2),
	"collection_target" numeric(14, 2),
	"lead_count_target" integer,
	"booking_count_target" integer,
	"notes" text,
	"set_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "financing_needed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "preferred_bank" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "receipt_no" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "receipt_issued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "receipt_voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "receipt_void_reason" text;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_milestones" ADD CONSTRAINT "payment_milestones_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_milestones" ADD CONSTRAINT "payment_milestones_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_targets" ADD CONSTRAINT "sales_targets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_targets" ADD CONSTRAINT "sales_targets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_targets" ADD CONSTRAINT "sales_targets_set_by_id_users_id_fk" FOREIGN KEY ("set_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_loans_booking" ON "loans" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "idx_loans_customer" ON "loans" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "idx_loans_status" ON "loans" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_loans_bank" ON "loans" USING btree ("bank_name");--> statement-breakpoint
CREATE INDEX "idx_loans_applied" ON "loans" USING btree ("application_date");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_milestone_booking_seq" ON "payment_milestones" USING btree ("booking_id","seq");--> statement-breakpoint
CREATE INDEX "idx_milestones_booking" ON "payment_milestones" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "idx_milestones_due" ON "payment_milestones" USING btree ("due_date");--> statement-breakpoint
CREATE INDEX "idx_milestones_status" ON "payment_milestones" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_targets_person_period_project" ON "sales_targets" USING btree ("user_id","period","project_id");--> statement-breakpoint
CREATE INDEX "idx_targets_period" ON "sales_targets" USING btree ("period");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_targets_person_period_all" ON "sales_targets" USING btree ("user_id","period") WHERE "sales_targets"."project_id" is null;