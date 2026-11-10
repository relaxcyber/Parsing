CREATE TABLE "creator_contacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"creator_id" integer NOT NULL,
	"email" text NOT NULL,
	"status" text NOT NULL,
	"confidence" double precision NOT NULL,
	"mx" text,
	"source" text NOT NULL,
	"source_url" text NOT NULL,
	"found_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "creator_contacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppressions_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "suppressions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "last_post_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "median_views" integer;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "er_views" double precision;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "affiliate" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "portfolio" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "socials" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "rates" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "links_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "quality" double precision;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "audit" jsonb;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "audited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "search_candidates" ADD COLUMN "lead" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "searches" ADD COLUMN "focus" text DEFAULT 'ugc' NOT NULL;--> statement-breakpoint
ALTER TABLE "searches" ADD COLUMN "audit_limit" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "creator_contacts" ADD CONSTRAINT "creator_contacts_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "creator_contacts_unique_idx" ON "creator_contacts" USING btree ("creator_id","email");