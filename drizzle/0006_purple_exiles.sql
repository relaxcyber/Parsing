CREATE TABLE "scrape_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"urls" jsonb NOT NULL,
	"mode" text DEFAULT 'auto' NOT NULL,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allow_paid" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"done" integer DEFAULT 0 NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "scrape_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "scrape_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" integer NOT NULL,
	"url" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"via" text,
	"error" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scrape_results" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "country" text;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "country_confidence" double precision;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "language" text;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "er_likes" double precision;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "manual_verdict" text;--> statement-breakpoint
ALTER TABLE "searches" ADD COLUMN "countries" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "searches" ADD COLUMN "languages" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "scrape_results" ADD CONSTRAINT "scrape_results_job_id_scrape_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."scrape_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scrape_jobs_status_idx" ON "scrape_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "scrape_results_job_url_idx" ON "scrape_results" USING btree ("job_id","url");