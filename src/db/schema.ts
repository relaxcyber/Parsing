import {
  boolean, doublePrecision, index, integer, jsonb, pgEnum, pgTable, serial, text, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core";
import type { ContentItem } from "@/core/contract";

export const providerKind = pgEnum("provider_kind", ["scraper", "llm"]);
export const keyStatus = pgEnum("key_status", ["active", "disabled", "invalid"]);
export const quotaPeriod = pgEnum("quota_period", ["minute", "day", "month", "none"]);

const ts = (name: string) => timestamp(name, { withTimezone: true });

/**
 * RLS увімкнено на всіх таблицях без політик: це закриває публічний REST API Supabase.
 * Застосунок підключається як власник таблиць, тому його це не обмежує.
 */
export const providers = pgTable("providers", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  kind: providerKind("kind").notNull(),
  /** Для LLM — база OpenAI-сумісного API. */
  baseUrl: text("base_url"),
  model: text("model"),
  builtin: boolean("builtin").notNull().default(false),
}).enableRLS();

export const apiKeys = pgTable(
  "api_keys",
  {
    id: serial("id").primaryKey(),
    providerId: integer("provider_id").notNull().references(() => providers.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    secretEnc: text("secret_enc").notNull(),
    secretTail: text("secret_tail").notNull(),
    status: keyStatus("status").notNull().default("active"),
    /** null — ліміт невідомий / не обмежений. */
    quotaLimit: doublePrecision("quota_limit"),
    quotaUsed: doublePrecision("quota_used").notNull().default(0),
    quotaUnit: text("quota_unit").notNull().default("requests"),
    quotaPeriod: quotaPeriod("quota_period").notNull().default("month"),
    periodStartedAt: ts("period_started_at").notNull().defaultNow(),
    cooldownUntil: ts("cooldown_until"),
    lastUsedAt: ts("last_used_at"),
    lastSyncedAt: ts("last_synced_at"),
    lastError: text("last_error"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("api_keys_provider_idx").on(t.providerId)],
).enableRLS();

export const usageEvents = pgTable(
  "usage_events",
  {
    id: serial("id").primaryKey(),
    keyId: integer("key_id").notNull().references(() => apiKeys.id, { onDelete: "cascade" }),
    at: ts("at").notNull().defaultNow(),
    units: doublePrecision("units").notNull().default(1),
    ok: boolean("ok").notNull(),
    httpStatus: integer("http_status"),
    purpose: text("purpose"),
  },
  (t) => [index("usage_events_key_at_idx").on(t.keyId, t.at)],
).enableRLS();

export const contentItems = pgTable(
  "content_items",
  {
    id: serial("id").primaryKey(),
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    kind: text("kind").notNull(),
    url: text("url").notNull(),
    authorUsername: text("author_username"),
    data: jsonb("data").$type<ContentItem>().notNull(),
    fetchedAt: ts("fetched_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("content_items_source_ext_idx").on(t.source, t.externalId),
    index("content_items_author_idx").on(t.source, t.authorUsername),
  ],
).enableRLS();

export type Provider = typeof providers.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
