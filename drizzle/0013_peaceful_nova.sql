CREATE TABLE "brand_scouts" (
	"id" serial PRIMARY KEY NOT NULL,
	"niche" text NOT NULL,
	"hashtags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"posts_per_tag" integer DEFAULT 40 NOT NULL,
	"max_creators" integer DEFAULT 60 NOT NULL,
	"max_brands" integer DEFAULT 40 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"brands" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"creator" jsonb,
	"pitch_queue" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "brand_scouts" ENABLE ROW LEVEL SECURITY;