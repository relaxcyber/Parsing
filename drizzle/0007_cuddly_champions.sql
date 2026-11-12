CREATE TABLE "creator_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"creator_id" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"followers" integer,
	"follows" integer,
	"posts_count" integer,
	"er_likes" double precision
);
--> statement-breakpoint
ALTER TABLE "creator_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"total" integer NOT NULL,
	"agree" integer NOT NULL,
	"threshold" integer NOT NULL,
	"results" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eval_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "llm_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"reply" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_cache" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "outreach_drafts" (
	"id" serial PRIMARY KEY NOT NULL,
	"creator_id" integer NOT NULL,
	"search_id" integer,
	"language" text NOT NULL,
	"style" text NOT NULL,
	"data" jsonb NOT NULL,
	"facts" jsonb NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outreach_drafts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "search_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_templates_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "search_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "audit_version" text;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "follows" integer;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "business_category" text;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "metrics" jsonb;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "trust" jsonb;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "trust_risk" text;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "ads" jsonb;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "analysis" jsonb;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "analyzed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "deep_audit" jsonb;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "ad_quality" double precision;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "deep_audited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "comments_report" jsonb;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "comments_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "review_note" text;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "outreach_status" text DEFAULT 'new' NOT NULL;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "outreach_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "outreach_note" text;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "hard_reject" text;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "hard_reject_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "search_candidates" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "search_candidates" ADD COLUMN "trust" double precision;--> statement-breakpoint
ALTER TABLE "search_candidates" ADD COLUMN "match" double precision;--> statement-breakpoint
ALTER TABLE "searches" ADD COLUMN "brief" text;--> statement-breakpoint
ALTER TABLE "searches" ADD COLUMN "brand_name" text;--> statement-breakpoint
ALTER TABLE "searches" ADD COLUMN "offer" text;--> statement-breakpoint
ALTER TABLE "searches" ADD COLUMN "letter_example" text;--> statement-breakpoint
ALTER TABLE "searches" ADD COLUMN "sources" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "searches" ADD COLUMN "criteria" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "searches" ADD COLUMN "weights" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "searches" ADD COLUMN "target_leads" integer;--> statement-breakpoint
ALTER TABLE "searches" ADD COLUMN "budget_usd" double precision;--> statement-breakpoint
ALTER TABLE "searches" ADD COLUMN "deep_limit" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "searches" ADD COLUMN "comments_limit" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "searches" ADD COLUMN "exclude_contacted" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "searches" ADD COLUMN "repeat_days" integer;--> statement-breakpoint
ALTER TABLE "searches" ADD COLUMN "parent_id" integer;--> statement-breakpoint
ALTER TABLE "creator_snapshots" ADD CONSTRAINT "creator_snapshots_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_search_id_searches_id_fk" FOREIGN KEY ("search_id") REFERENCES "public"."searches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "creator_snapshots_creator_idx" ON "creator_snapshots" USING btree ("creator_id","at");--> statement-breakpoint
CREATE INDEX "outreach_drafts_creator_idx" ON "outreach_drafts" USING btree ("creator_id","created_at");