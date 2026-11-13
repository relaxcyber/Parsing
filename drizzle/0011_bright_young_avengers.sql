CREATE TABLE "orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"pitch_id" integer,
	"client_id" integer,
	"profile" jsonb NOT NULL,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"spec" jsonb,
	"asked" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"pending" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"draft" text,
	"draft_uk" text,
	"draft_kind" text,
	"draft_asks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"draft_issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"search_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'clarifying' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_pitch_id_job_pitches_id_fk" FOREIGN KEY ("pitch_id") REFERENCES "public"."job_pitches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;