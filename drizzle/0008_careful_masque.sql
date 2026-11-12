CREATE TABLE "clients" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"policy" jsonb NOT NULL,
	"mailbox_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mailboxes" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"from_name" text,
	"smtp_host" text NOT NULL,
	"smtp_port" integer DEFAULT 465 NOT NULL,
	"imap_host" text NOT NULL,
	"imap_port" integer DEFAULT 993 NOT NULL,
	"username" text NOT NULL,
	"password_enc" text NOT NULL,
	"daily_limit" integer DEFAULT 30 NOT NULL,
	"last_uid" integer,
	"uid_validity" text,
	"last_polled_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailboxes_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "mailboxes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "outreach_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"thread_id" integer NOT NULL,
	"mailbox_id" integer,
	"direction" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"message_id" text,
	"in_reply_to" text,
	"from_email" text,
	"to_email" text,
	"ai" jsonb,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"sent_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outreach_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "outreach_threads" (
	"id" serial PRIMARY KEY NOT NULL,
	"creator_id" integer NOT NULL,
	"client_id" integer NOT NULL,
	"search_id" integer,
	"mailbox_id" integer,
	"to_email" text NOT NULL,
	"subject" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"needs_human" text,
	"open_questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rounds" integer DEFAULT 0 NOT NULL,
	"asked_fee_usd" double precision,
	"offered_fee_usd" double precision,
	"terms" jsonb,
	"shipping" text,
	"followups" integer DEFAULT 0 NOT NULL,
	"next_action_at" timestamp with time zone,
	"agreed_at" timestamp with time zone,
	"shipped_at" timestamp with time zone,
	"post_due_at" timestamp with time zone,
	"post_url" text,
	"posted_at" timestamp with time zone,
	"post_check" jsonb,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outreach_threads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "searches" ADD COLUMN "client_id" integer;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_messages" ADD CONSTRAINT "outreach_messages_thread_id_outreach_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."outreach_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_messages" ADD CONSTRAINT "outreach_messages_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_threads" ADD CONSTRAINT "outreach_threads_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_threads" ADD CONSTRAINT "outreach_threads_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_threads" ADD CONSTRAINT "outreach_threads_search_id_searches_id_fk" FOREIGN KEY ("search_id") REFERENCES "public"."searches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_threads" ADD CONSTRAINT "outreach_threads_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outreach_messages_thread_idx" ON "outreach_messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "outreach_messages_status_idx" ON "outreach_messages" USING btree ("status","mailbox_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outreach_messages_mid_idx" ON "outreach_messages" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outreach_threads_pair_idx" ON "outreach_threads" USING btree ("creator_id","client_id");--> statement-breakpoint
CREATE INDEX "outreach_threads_status_idx" ON "outreach_threads" USING btree ("status","next_action_at");--> statement-breakpoint
ALTER TABLE "searches" ADD CONSTRAINT "searches_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;