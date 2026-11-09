CREATE TYPE "public"."key_status" AS ENUM('active', 'disabled', 'invalid');--> statement-breakpoint
CREATE TYPE "public"."provider_kind" AS ENUM('scraper', 'llm');--> statement-breakpoint
CREATE TYPE "public"."quota_period" AS ENUM('minute', 'day', 'month', 'none');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider_id" integer NOT NULL,
	"label" text NOT NULL,
	"secret_enc" text NOT NULL,
	"secret_tail" text NOT NULL,
	"status" "key_status" DEFAULT 'active' NOT NULL,
	"quota_limit" double precision,
	"quota_used" double precision DEFAULT 0 NOT NULL,
	"quota_unit" text DEFAULT 'requests' NOT NULL,
	"quota_period" "quota_period" DEFAULT 'month' NOT NULL,
	"period_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cooldown_until" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"kind" text NOT NULL,
	"url" text NOT NULL,
	"author_username" text,
	"data" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"kind" "provider_kind" NOT NULL,
	"base_url" text,
	"model" text,
	"builtin" boolean DEFAULT false NOT NULL,
	CONSTRAINT "providers_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"key_id" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"units" double precision DEFAULT 1 NOT NULL,
	"ok" boolean NOT NULL,
	"http_status" integer,
	"purpose" text
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_provider_idx" ON "api_keys" USING btree ("provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_items_source_ext_idx" ON "content_items" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "content_items_author_idx" ON "content_items" USING btree ("source","author_username");--> statement-breakpoint
CREATE INDEX "usage_events_key_at_idx" ON "usage_events" USING btree ("key_id","at");