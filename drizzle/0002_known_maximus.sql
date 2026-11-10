CREATE TABLE "collect_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"target_key" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"item_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "collect_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "fingerprint" text;--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "raw" jsonb;--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "collect_runs_target_idx" ON "collect_runs" USING btree ("target_key","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "collect_runs_running_idx" ON "collect_runs" USING btree ("target_key") WHERE "collect_runs"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_fingerprint_idx" ON "api_keys" USING btree ("provider_id","fingerprint");--> statement-breakpoint
CREATE INDEX "content_items_fetched_idx" ON "content_items" USING btree ("fetched_at");