ALTER TABLE "api_keys" ADD COLUMN "provider_resets_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "collect_runs" ADD COLUMN "external_run_id" text;