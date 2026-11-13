ALTER TABLE "job_pitches" ADD COLUMN "options" jsonb;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "review" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "top_ups" integer DEFAULT 0 NOT NULL;