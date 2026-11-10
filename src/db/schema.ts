import { sql } from "drizzle-orm";
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
    /** HMAC секрету — щоб ловити дублікати без розшифрування. */
    fingerprint: text("fingerprint"),
    status: keyStatus("status").notNull().default("active"),
    /** null — ліміт невідомий / не обмежений. */
    quotaLimit: doublePrecision("quota_limit"),
    quotaUsed: doublePrecision("quota_used").notNull().default(0),
    quotaUnit: text("quota_unit").notNull().default("requests"),
    quotaPeriod: quotaPeriod("quota_period").notNull().default("month"),
    periodStartedAt: ts("period_started_at").notNull().defaultNow(),
    /** Коли провайдер сам обнулить квоту (напр. кінець місячного циклу Apify) — лише для показу й звірки. */
    providerResetsAt: ts("provider_resets_at"),
    cooldownUntil: ts("cooldown_until"),
    lastUsedAt: ts("last_used_at"),
    lastSyncedAt: ts("last_synced_at"),
    lastError: text("last_error"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("api_keys_provider_idx").on(t.providerId),
    uniqueIndex("api_keys_fingerprint_idx").on(t.providerId, t.fingerprint),
  ],
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
    /** Сира відповідь джерела: щоб не платити вдруге, якщо знадобиться поле, якого немає в контракті. */
    raw: jsonb("raw"),
    firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
    fetchedAt: ts("fetched_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("content_items_source_ext_idx").on(t.source, t.externalId),
    index("content_items_author_idx").on(t.source, t.authorUsername),
    index("content_items_fetched_idx").on(t.fetchedAt),
  ],
).enableRLS();

/** Журнал зборів: кеш за ціллю, захист від подвійного запуску, історія. */
export const collectRuns = pgTable(
  "collect_runs",
  {
    id: serial("id").primaryKey(),
    targetKey: text("target_key").notNull(),
    status: text("status").$type<"running" | "done" | "failed">().notNull().default("running"),
    itemIds: jsonb("item_ids").$type<number[]>().notNull().default([]),
    skipped: integer("skipped").notNull().default(0),
    error: text("error"),
    /** Зовнішній запуск (Apify run id) — щоб оплачений результат можна було забрати пізніше. */
    externalRunId: text("external_run_id"),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    index("collect_runs_target_idx").on(t.targetKey, t.startedAt),
    uniqueIndex("collect_runs_running_idx").on(t.targetKey).where(sql`${t.status} = 'running'`),
  ],
).enableRLS();

export const sessions = pgTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  expiresAt: ts("expires_at").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
}).enableRLS();

export type Provider = typeof providers.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;

/** Креатор — окрема сутність: один рядок на автора, скільки б дописів і пошуків його не згадували. */
export const creators = pgTable(
  "creators",
  {
    id: serial("id").primaryKey(),
    platform: text("platform").notNull(),
    /** Ім’я в нижньому регістрі — ключ дедуплікації в межах платформи. */
    username: text("username").notNull(),
    externalId: text("external_id"),
    displayName: text("display_name"),
    bio: text("bio"),
    followers: integer("followers"),
    postsCount: integer("posts_count"),
    links: jsonb("links").$type<string[]>().notNull().default([]),
    emails: jsonb("emails").$type<string[]>().notNull().default([]),
    avatarUrl: text("avatar_url"),
    isPrivate: boolean("is_private"),
    isBusiness: boolean("is_business"),
    verified: boolean("verified"),
    profileFetchedAt: ts("profile_fetched_at"),
    /** Активність: дата останнього допису та перегляди відносно аудиторії. */
    lastPostAt: ts("last_post_at"),
    medianViews: integer("median_views"),
    erViews: doublePrecision("er_views"),
    /** Знайдене на сторінках-візитках і в посиланнях профілю. */
    affiliate: jsonb("affiliate").$type<string[]>().notNull().default([]),
    portfolio: jsonb("portfolio").$type<string[]>().notNull().default([]),
    socials: jsonb("socials").$type<Record<string, string>>().notNull().default({}),
    rates: jsonb("rates").$type<CreatorRate[]>().notNull().default([]),
    linksCheckedAt: ts("links_checked_at"),
    /** Візуальний аудит: Quality Index 0–100 і сира відповідь моделі. */
    quality: doublePrecision("quality"),
    audit: jsonb("audit").$type<Record<string, unknown>>(),
    auditedAt: ts("audited_at"),
    firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("creators_platform_username_idx").on(t.platform, t.username)],
).enableRLS();

export type CreatorRate = { title: string; amount: number; currency: string; sourceUrl: string };

/** Контакти з походженням: звідки взято адресу й коли — потрібно для GDPR (ст. 14) і для довіри до бази. */
export const creatorContacts = pgTable(
  "creator_contacts",
  {
    id: serial("id").primaryKey(),
    creatorId: integer("creator_id").notNull().references(() => creators.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    status: text("status").notNull(),
    confidence: doublePrecision("confidence").notNull(),
    mx: text("mx"),
    /** bio — з профілю; link_page — зі сторінки-візитки. */
    source: text("source").notNull(),
    sourceUrl: text("source_url").notNull(),
    foundAt: ts("found_at").notNull().defaultNow(),
    checkedAt: ts("checked_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("creator_contacts_unique_idx").on(t.creatorId, t.email)],
).enableRLS();

/** Список виключень (GDPR ст. 21): цих авторів і адреси більше не збираємо й не показуємо. */
export const suppressions = pgTable(
  "suppressions",
  {
    id: serial("id").primaryKey(),
    /** "instagram:name" або "email:<sha256>". */
    key: text("key").notNull().unique(),
    reason: text("reason"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
).enableRLS();

export type SearchProgress = { stage: string; done: number; total: number };
export type SearchStats = {
  posts?: number; authors?: number; shortlisted?: number; profilesFetched?: number; profilesReused?: number; qualified?: number;
  linkPages?: number; withEmail?: number; audited?: number; leads?: number; note?: string;
};

export const searches = pgTable(
  "searches",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    platform: text("platform").notNull().default("instagram"),
    hashtags: jsonb("hashtags").$type<string[]>().notNull(),
    /** Слова ніші: що більше збігів у дописах і біо, то вищий Fit. */
    keywords: jsonb("keywords").$type<string[]>().notNull().default([]),
    stopWords: jsonb("stop_words").$type<string[]>().notNull().default([]),
    postsPerTag: integer("posts_per_tag").notNull().default(50),
    maxProfiles: integer("max_profiles").notNull().default(150),
    minFollowers: integer("min_followers"),
    maxFollowers: integer("max_followers"),
    outreachLanguage: text("outreach_language").notNull().default("en"),
    /** ugc — шукаємо авторів контенту на замовлення; affiliate — авторів із партнерськими вітринами. */
    focus: text("focus").$type<"ugc" | "affiliate">().notNull().default("ugc"),
    /** Скільком найкращим кандидатам робити візуальний аудит (він витрачає ліміти мовної моделі). */
    auditLimit: integer("audit_limit").notNull().default(30),
    status: text("status").$type<"queued" | "running" | "done" | "failed" | "cancelled">().notNull().default("queued"),
    progress: jsonb("progress").$type<SearchProgress>(),
    stats: jsonb("stats").$type<SearchStats>().notNull().default({}),
    error: text("error"),
    createdAt: ts("created_at").notNull().defaultNow(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
  },
  (t) => [index("searches_status_idx").on(t.status, t.createdAt)],
).enableRLS();

export const searchCandidates = pgTable(
  "search_candidates",
  {
    id: serial("id").primaryKey(),
    searchId: integer("search_id").notNull().references(() => searches.id, { onDelete: "cascade" }),
    creatorId: integer("creator_id").notNull().references(() => creators.id, { onDelete: "cascade" }),
    stage: text("stage").$type<"found" | "filtered_out" | "shortlisted" | "rejected" | "qualified">().notNull().default("found"),
    /** Три незалежні індекси, 0–100. Quality дає візуальний аудит (порожньо, якщо його не було). */
    fit: doublePrecision("fit"),
    readiness: doublePrecision("readiness"),
    quality: doublePrecision("quality"),
    score: doublePrecision("score").notNull().default(0),
    reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
    /** «Готовий лід»: активний, є придатний email і якість візуалу не нижче порога. */
    lead: boolean("lead").notNull().default(false),
    postIds: jsonb("post_ids").$type<number[]>().notNull().default([]),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("search_candidates_unique_idx").on(t.searchId, t.creatorId),
    index("search_candidates_rank_idx").on(t.searchId, t.stage, t.score),
  ],
).enableRLS();

export type Creator = typeof creators.$inferSelect;
export type Search = typeof searches.$inferSelect;
export type SearchCandidate = typeof searchCandidates.$inferSelect;
