CREATE TABLE "creators" (
	"id" serial PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"username" text NOT NULL,
	"external_id" text,
	"display_name" text,
	"bio" text,
	"followers" integer,
	"posts_count" integer,
	"links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"emails" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"avatar_url" text,
	"is_private" boolean,
	"is_business" boolean,
	"verified" boolean,
	"profile_fetched_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "creators" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "search_candidates" (
	"id" serial PRIMARY KEY NOT NULL,
	"search_id" integer NOT NULL,
	"creator_id" integer NOT NULL,
	"stage" text DEFAULT 'found' NOT NULL,
	"fit" double precision,
	"readiness" double precision,
	"quality" double precision,
	"score" double precision DEFAULT 0 NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"post_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "search_candidates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "searches" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"platform" text DEFAULT 'instagram' NOT NULL,
	"hashtags" jsonb NOT NULL,
	"keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stop_words" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"posts_per_tag" integer DEFAULT 50 NOT NULL,
	"max_profiles" integer DEFAULT 150 NOT NULL,
	"min_followers" integer,
	"max_followers" integer,
	"outreach_language" text DEFAULT 'en' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"progress" jsonb,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "searches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "search_candidates" ADD CONSTRAINT "search_candidates_search_id_searches_id_fk" FOREIGN KEY ("search_id") REFERENCES "public"."searches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_candidates" ADD CONSTRAINT "search_candidates_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "creators_platform_username_idx" ON "creators" USING btree ("platform","username");--> statement-breakpoint
CREATE UNIQUE INDEX "search_candidates_unique_idx" ON "search_candidates" USING btree ("search_id","creator_id");--> statement-breakpoint
CREATE INDEX "search_candidates_rank_idx" ON "search_candidates" USING btree ("search_id","stage","score");--> statement-breakpoint
CREATE INDEX "searches_status_idx" ON "searches" USING btree ("status","created_at");