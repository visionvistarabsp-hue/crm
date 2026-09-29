CREATE TABLE "customer_activities" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"type" text DEFAULT 'NOTE' NOT NULL,
	"note" text,
	"meta" jsonb DEFAULT '{}'::jsonb,
	"performed_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_activities" ADD CONSTRAINT "customer_activities_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_customer_activities_customer" ON "customer_activities" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "idx_customer_activities_customer_created" ON "customer_activities" USING btree ("customer_id","created_at");