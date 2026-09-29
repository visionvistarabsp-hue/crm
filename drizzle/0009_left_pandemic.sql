CREATE TABLE "message_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"recipient" text NOT NULL,
	"subject" text,
	"body_text" text,
	"status" text NOT NULL,
	"provider_message_id" text,
	"lead_id" text,
	"user_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_logs" ADD CONSTRAINT "message_logs_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_logs" ADD CONSTRAINT "message_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_message_logs_channel_created" ON "message_logs" USING btree ("channel","created_at");--> statement-breakpoint
CREATE INDEX "idx_message_logs_lead" ON "message_logs" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "idx_message_logs_recipient" ON "message_logs" USING btree ("recipient");