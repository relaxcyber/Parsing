CREATE TABLE "brand_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"platform" text DEFAULT 'instagram' NOT NULL,
	"handle" text NOT NULL,
	"name" text,
	"bio" text,
	"category" text,
	"followers" integer,
	"website" text,
	"email" text,
	"email_source" text,
	"verdict" text,
	"verdict_why" text,
	"by_you" boolean DEFAULT false NOT NULL,
	"checked_at" timestamp with time zone,
	"verify_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "brand_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "brand_collabs" (
	"id" serial PRIMARY KEY NOT NULL,
	"brand_id" integer NOT NULL,
	"creator" text NOT NULL,
	"creator_id" integer,
	"creator_followers" integer,
	"post_url" text NOT NULL,
	"paid" boolean DEFAULT false NOT NULL,
	"reason" text,
	"at" timestamp with time zone,
	"likes" integer,
	"comments" integer,
	"views" integer,
	"search_id" integer,
	"scout_id" integer,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "brand_collabs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "brand_collabs" ADD CONSTRAINT "brand_collabs_brand_id_brand_accounts_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brand_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_collabs" ADD CONSTRAINT "brand_collabs_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_collabs" ADD CONSTRAINT "brand_collabs_search_id_searches_id_fk" FOREIGN KEY ("search_id") REFERENCES "public"."searches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_collabs" ADD CONSTRAINT "brand_collabs_scout_id_brand_scouts_id_fk" FOREIGN KEY ("scout_id") REFERENCES "public"."brand_scouts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "brand_accounts_handle_idx" ON "brand_accounts" USING btree ("platform","handle");--> statement-breakpoint
CREATE UNIQUE INDEX "brand_collabs_post_idx" ON "brand_collabs" USING btree ("brand_id","post_url");--> statement-breakpoint
CREATE INDEX "brand_collabs_creator_idx" ON "brand_collabs" USING btree ("creator");