CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_auth0_sub_unique";--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_sessions_user" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_expires" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
-- The removed Auth0 auto-provisioning path inserted placeholder users with an
-- empty email, and could mint the same address twice. Repair those rows so the
-- case-insensitive unique index below can be created. The id suffix is
-- appended to the local part, so the address stays inside its own domain.
UPDATE "users" SET "email" = 'legacy-' || "id" || '@noreply.local'
WHERE "email" IS NULL OR btrim("email") = '';--> statement-breakpoint
UPDATE "users" AS dup SET "email" = split_part(dup."email", '@', 1) || '-' || dup."id" || '@' || split_part(dup."email", '@', 2)
WHERE dup."id" <> (
  SELECT keep."id" FROM "users" AS keep
  WHERE lower(keep."email") = lower(dup."email")
  ORDER BY keep."created_at", keep."id"
  LIMIT 1
);--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_key" ON "users" USING btree (lower("email"));--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "auth0_sub";
