CREATE TABLE "job_pitches" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"job_text" text NOT NULL,
	"profile" jsonb NOT NULL,
	"analysis" jsonb,
	"proposal" text,
	"proposal_uk" text,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"samples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"search_id" integer,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_pitches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "job_pitches" ADD CONSTRAINT "job_pitches_search_id_searches_id_fk" FOREIGN KEY ("search_id") REFERENCES "public"."searches"("id") ON DELETE set null ON UPDATE no action;