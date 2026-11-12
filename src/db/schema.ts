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
    /** Оцінка країни та мови за непрямими ознаками (прапорці, міста, Amazon, службові слова). */
    country: text("country"),
    countryConfidence: doublePrecision("country_confidence"),
    language: text("language"),
    /** Медіана вподобань останніх дописів до кількості підписників. */
    erLikes: doublePrecision("er_likes"),
    /** Ваш вердикт «взяв би / ні» — еталон для калібрування порогів моделі. */
    manualVerdict: text("manual_verdict").$type<"yes" | "no">(),
    /** Візуальний аудит: Quality Index 0–100 і сира відповідь моделі. */
    quality: doublePrecision("quality"),
    audit: jsonb("audit").$type<Record<string, unknown>>(),
    auditedAt: ts("audited_at"),
    /** Версія промпту, яким зроблено аудит: щоб порівнювати версії на ваших вердиктах. */
    auditVersion: text("audit_version"),
    follows: integer("follows"),
    businessCategory: text("business_category"),
    /** Порахований кодом підсумок дописів: медіани, розкид, частота. */
    metrics: jsonb("metrics").$type<Record<string, unknown>>(),
    /** Довіра до аудиторії: рівень ризику накрутки з причинами. */
    trust: jsonb("trust").$type<Record<string, unknown>>(),
    trustRisk: text("trust_risk").$type<"low" | "medium" | "high" | "unknown">(),
    /** Реклама: частка рекламних дописів, бренди, як реклама «заходить» аудиторії. */
    ads: jsonb("ads").$type<Record<string, unknown>>(),
    /** Аналіз тексту профілю мовною моделлю — лише висновки з перевіреними цитатами. */
    analysis: jsonb("analysis").$type<Record<string, unknown>>(),
    analyzedAt: ts("analyzed_at"),
    /** Глибокий аудит: кадри з роликів, розшифровка мовлення, розбір рекламної подачі. */
    deepAudit: jsonb("deep_audit").$type<Record<string, unknown>>(),
    adQuality: doublePrecision("ad_quality"),
    deepAuditedAt: ts("deep_audited_at"),
    /** Реакція аудиторії: вибірка коментарів і її розбір. */
    commentsReport: jsonb("comments_report").$type<Record<string, unknown>>(),
    commentsAt: ts("comments_at"),
    /** Чому автора варто переглянути вручну (оцінка біля порога, моделі розійшлися). */
    reviewNote: text("review_note"),
    /** Робота з автором: new → contacted → replied → in_work / declined. */
    outreachStatus: text("outreach_status").$type<OutreachStatus>().notNull().default("new"),
    outreachAt: ts("outreach_at"),
    outreachNote: text("outreach_note"),
    /** Пам’ять відмов: магазин, агенція, закритий профіль — повторно за профіль не платимо. */
    hardReject: text("hard_reject"),
    hardRejectAt: ts("hard_reject_at"),
    firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("creators_platform_username_idx").on(t.platform, t.username)],
).enableRLS();

export type CreatorRate = { title: string; amount: number; currency: string; sourceUrl: string };
export type OutreachStatus = "new" | "contacted" | "replied" | "in_work" | "declined";

/** Знімки цифр автора при кожному зборі: з часом видно стрибки підписників. */
export const creatorSnapshots = pgTable(
  "creator_snapshots",
  {
    id: serial("id").primaryKey(),
    creatorId: integer("creator_id").notNull().references(() => creators.id, { onDelete: "cascade" }),
    at: ts("at").notNull().defaultNow(),
    followers: integer("followers"),
    follows: integer("follows"),
    postsCount: integer("posts_count"),
    erLikes: doublePrecision("er_likes"),
  },
  (t) => [index("creator_snapshots_creator_idx").on(t.creatorId, t.at)],
).enableRLS();

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
export type SourceStats = { authors: number; qualified: number; leads: number; costUsd: number };
export type SearchStats = {
  posts?: number; authors?: number; shortlisted?: number; profilesFetched?: number; profilesReused?: number; qualified?: number;
  linkPages?: number; withEmail?: number; audited?: number; leads?: number; note?: string;
  analyzed?: number; deepAudited?: number; commentsAnalyzed?: number; review?: number; skippedKnown?: number;
  costUsd?: number; waves?: number; expandedTags?: string[]; bySource?: Record<string, SourceStats>; notes?: string[];
};

export type CriterionMode = "required" | "preferred" | "off";
export type ContentFormat = "talking_to_camera" | "product_demo" | "voiceover" | "subtitles";
/** Гнучкі критерії: кожен — обов’язково (відсіює), бажано (піднімає в рейтингу) або не важливо. */
export type SearchCriteria = {
  followers: CriterionMode;
  country: CriterionMode;
  language: CriterionMode;
  activity: { mode: CriterionMode; days: number };
  er: { mode: CriterionMode; minPct: number };
  email: CriterionMode;
  ads: CriterionMode;
  trust: { mode: CriterionMode; maxRisk: "low" | "medium" };
  formats: { mode: CriterionMode; list: ContentFormat[] };
  quality: { min: number; lead: number };
};
/** Вага кожного індексу в загальній оцінці (0 — не враховувати). */
export type IndexWeights = { fit: number; quality: number; readiness: number; trust: number; match: number };
/** Джерела кандидатів, крім хештегів. */
export type SearchSources = {
  bioQueries: string[]; competitors: string[]; seeds: string[]; places: string[]; usernames: string[]; webQueries: string[];
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
    /** Обмеження за країною та мовою (порожньо — без обмежень). Автори з невизначеною країною проходять. */
    countries: jsonb("countries").$type<string[]>().notNull().default([]),
    languages: jsonb("languages").$type<string[]>().notNull().default([]),
    /** ugc — шукаємо авторів контенту на замовлення; affiliate — авторів із партнерськими вітринами. */
    focus: text("focus").$type<"ugc" | "affiliate">().notNull().default("ugc"),
    /** Скільком найкращим кандидатам робити візуальний аудит (він витрачає ліміти мовної моделі). */
    auditLimit: integer("audit_limit").notNull().default(30),
    /** Бриф: що за бізнес, товар і який автор потрібен — його бачать модель-аналітик і автор листів. */
    brief: text("brief"),
    brandName: text("brand_name"),
    /** Умови співпраці для листа (ставка, формат, строки). Модель не може вигадати інших. */
    offer: text("offer"),
    /** Приклад листа, тон якого вам подобається. */
    letterExample: text("letter_example"),
    sources: jsonb("sources").$type<Partial<SearchSources>>().notNull().default({}),
    criteria: jsonb("criteria").$type<Partial<SearchCriteria>>().notNull().default({}),
    weights: jsonb("weights").$type<Partial<IndexWeights>>().notNull().default({}),
    /** Автопілот: зупинитися, коли знайдено стільки лідів або витрачено бюджет. */
    targetLeads: integer("target_leads"),
    budgetUsd: doublePrecision("budget_usd"),
    /** Скільком найкращим глибокий аудит (кадри з роликів, мовлення) і платний розбір коментарів. */
    deepLimit: integer("deep_limit").notNull().default(10),
    commentsLimit: integer("comments_limit").notNull().default(0),
    /** Не пропонувати авторів, яким уже писали. */
    excludeContacted: boolean("exclude_contacted").notNull().default(true),
    /** Повторювати кожні N днів, показуючи лише нових авторів. */
    repeatDays: integer("repeat_days"),
    parentId: integer("parent_id"),
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
    /** Звідки прийшов автор: «#тег», «біо: запит», «відмітки @бренд» тощо — для ціни ліда за джерелом. */
    source: text("source"),
    /** Індекси «Довіра» й «Відповідність критеріям бажано». */
    trust: doublePrecision("trust"),
    match: doublePrecision("match"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("search_candidates_unique_idx").on(t.searchId, t.creatorId),
    index("search_candidates_rank_idx").on(t.searchId, t.stage, t.score),
  ],
).enableRLS();

/** Збережені налаштування пошуку під нішу чи клієнта. */
export const searchTemplates = pgTable("search_templates", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  data: jsonb("data").$type<Record<string, string>>().notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
}).enableRLS();

/** Кеш відповідей мовної моделі: той самий запит удруге не витрачає ліміт. */
export const llmCache = pgTable("llm_cache", {
  key: text("key").primaryKey(),
  purpose: text("purpose").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  reply: text("reply").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
}).enableRLS();

/** Чернетки листів: тексти, лист фактів, з якого їх написано, і знайдені перевіркою проблеми. */
export const outreachDrafts = pgTable(
  "outreach_drafts",
  {
    id: serial("id").primaryKey(),
    creatorId: integer("creator_id").notNull().references(() => creators.id, { onDelete: "cascade" }),
    searchId: integer("search_id").references(() => searches.id, { onDelete: "set null" }),
    language: text("language").notNull(),
    /** «example» — у тоні вашого прикладу, «standard» — стандартний. Для частки відповідей за стилем. */
    style: text("style").notNull(),
    data: jsonb("data").$type<Record<string, string>>().notNull(),
    facts: jsonb("facts").$type<Record<string, unknown>>().notNull(),
    issues: jsonb("issues").$type<string[]>().notNull().default([]),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("outreach_drafts_creator_idx").on(t.creatorId, t.createdAt)],
).enableRLS();

/** Перевірка промпту на ваших вердиктах: збіг моделі з вами для кожної версії. */
export const evalRuns = pgTable("eval_runs", {
  id: serial("id").primaryKey(),
  version: text("version").notNull(),
  total: integer("total").notNull(),
  agree: integer("agree").notNull(),
  threshold: integer("threshold").notNull(),
  results: jsonb("results").$type<{ creatorId: number; verdict: "yes" | "no"; quality: number | null }[]>().notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
}).enableRLS();

export type Creator = typeof creators.$inferSelect;
export type Search = typeof searches.$inferSelect;
export type SearchCandidate = typeof searchCandidates.$inferSelect;

export type ScrapeField = { name: string; selector?: string; attr?: string };
export type ScrapeMode = "auto" | "selectors" | "ai";

/** Пакетний збір сторінок із витягом полів. */
export const scrapeJobs = pgTable(
  "scrape_jobs",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    urls: jsonb("urls").$type<string[]>().notNull(),
    mode: text("mode").$type<ScrapeMode>().notNull().default("auto"),
    fields: jsonb("fields").$type<ScrapeField[]>().notNull().default([]),
    /** Дозволити платний Firecrawl, коли сторінка не віддалася безкоштовно. */
    allowPaid: boolean("allow_paid").notNull().default(false),
    status: text("status").$type<"queued" | "running" | "done" | "failed" | "cancelled">().notNull().default("queued"),
    done: integer("done").notNull().default(0),
    total: integer("total").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    error: text("error"),
    createdAt: ts("created_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
  },
  (t) => [index("scrape_jobs_status_idx").on(t.status, t.createdAt)],
).enableRLS();

export const scrapeResults = pgTable(
  "scrape_results",
  {
    id: serial("id").primaryKey(),
    jobId: integer("job_id").notNull().references(() => scrapeJobs.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    data: jsonb("data").$type<Record<string, string | number | null>>().notNull().default({}),
    via: text("via"),
    error: text("error"),
    fetchedAt: ts("fetched_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("scrape_results_job_url_idx").on(t.jobId, t.url)],
).enableRLS();

export type ScrapeJob = typeof scrapeJobs.$inferSelect;
