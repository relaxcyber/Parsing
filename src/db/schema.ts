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
export type OutreachStatus = "new" | "contacted" | "replied" | "in_work" | "posted" | "declined";

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
    /** Перевірка сервісом (ZeroBounce, MillionVerifier, Hunter) перед першим листом. */
    verdict: text("verdict").$type<"valid" | "invalid" | "risky" | "unknown">(),
    verifiedBy: text("verified_by"),
    verifiedAt: ts("verified_at"),
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
    /** Клієнт (бренд), для якого шукаємо: його правила переговорів і звіт. */
    clientId: integer("client_id").references(() => clients.id, { onDelete: "set null" }),
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

/** Відповідь, яку дала людина на питання, якого не було в правилах: далі ІІ відповідає сам. */
export type FaqEntry = { q: string; a: string; addedAt: string };

/**
 * Правила переговорів клієнта. ІІ відповідає й торгується лише в цих межах: ставку понад стелю,
 * нові умови й питання, на які тут немає відповіді, він передає людині.
 */
export type ClientPolicy = {
  brandName: string;
  website: string;
  /** Що пропонуємо: товар, послуга. */
  product: string;
  offerType: "barter" | "paid" | "both";
  productValueUsd: number | null;
  /** Перша пропозиція й жорстка стеля оплати, $. */
  feeTargetUsd: number | null;
  feeMaxUsd: number | null;
  /** Скільки разів можна торгуватися, перш ніж покликати людину. */
  maxRounds: number;
  /** Що робити, якщо автор просить більше за стелю. */
  aboveMax: "escalate" | "decline";
  deliverables: string;
  /** Скільки днів на публікацію після отримання товару. */
  deadlineDays: number;
  usageRights: string;
  disclosure: string;
  /** Що автор має відмітити в дописі: @бренд, #хештег — за цим перевіряється публікація. */
  mustTag: string[];
  /** Куди можемо відправити товар (коди країн); порожньо — куди завгодно. */
  shipsTo: string[];
  /** Інші правила словами (довірений текст від вас). */
  notes: string;
  faq: FaqEntry[];
  /** approve — кожен лист чекає вашого «Надіслати»; auto — перевірені листи йдуть самі. */
  mode: "approve" | "auto";
  /** Через скільки днів без відповіді нагадати (двічі), далі — «без відповіді». */
  followupDays: number;
  senderName: string;
};

export type ClientBilling = {
  model?: "retainer" | "per_post" | "both" | "none";
  retainerUsd?: number | null;
  perPostUsd?: number | null;
  /** З якої дати рахувати абонемент (YYYY-MM-DD). */
  startedAt?: string | null;
  /** Хто платить авторам і за товар: якщо ви — це ваші витрати. */
  creatorFeesBy?: "brand" | "me";
  productBy?: "brand" | "me";
};

export const clients = pgTable("clients", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  policy: jsonb("policy").$type<ClientPolicy>().notNull(),
  mailboxId: integer("mailbox_id").references(() => mailboxes.id, { onDelete: "set null" }),
  /** Додаткові скриньки: нові листування розподіляються між ними за вільним денним лімітом. */
  mailboxPool: jsonb("mailbox_pool").$type<number[]>().notNull().default([]),
  /** Як вам платить клієнт — для розрахунку прибутковості. */
  billing: jsonb("billing").$type<ClientBilling>().notNull().default({}),
  createdAt: ts("created_at").notNull().defaultNow(),
}).enableRLS();

/** Поштова скринька для листування: SMTP — надсилання, IMAP — відповіді. Пароль зашифровано MASTER_KEY. */
export const mailboxes = pgTable("mailboxes", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  fromName: text("from_name"),
  smtpHost: text("smtp_host").notNull(),
  smtpPort: integer("smtp_port").notNull().default(465),
  imapHost: text("imap_host").notNull(),
  imapPort: integer("imap_port").notNull().default(993),
  username: text("username").notNull(),
  passwordEnc: text("password_enc").notNull(),
  /** Не більше стількох листів на добу: нова скринька, що шле сотні листів, швидко потрапляє в спам. */
  dailyLimit: integer("daily_limit").notNull().default(30),
  /** Останній прочитаний UID у теці «Вхідні» — щоб не обробляти листи двічі. */
  lastUid: integer("last_uid"),
  uidValidity: text("uid_validity"),
  lastPolledAt: ts("last_polled_at"),
  lastError: text("last_error"),
  /** Поступовий розгін: нова скринька починає з 5 листів на добу й додає по 2 щодня до денного ліміту. */
  warmup: boolean("warmup").notNull().default(true),
  /** Скриньку зупинено (забагато недоставлених листів чи помилок надсилання) — листи з неї не йдуть. */
  pausedAt: ts("paused_at"),
  pausedReason: text("paused_reason"),
  /** SPF, DKIM, DMARC домену відправника. */
  dns: jsonb("dns").$type<DomainCheck>(),
  createdAt: ts("created_at").notNull().defaultNow(),
}).enableRLS();

export type DomainCheck = {
  checkedAt: string; domain: string; freemail: boolean;
  spf: string | null; dmarc: string | null; dkimSelector: string | null; warnings: string[];
};

/** Облік часу на клієнта: скільки годин пішло — щоб бачити реальну ставку за годину. */
export const timeEntries = pgTable(
  "time_entries",
  {
    id: serial("id").primaryKey(),
    clientId: integer("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    day: text("day").notNull(),
    minutes: integer("minutes").notNull(),
    note: text("note"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("time_entries_client_idx").on(t.clientId, t.day)],
).enableRLS();

export type ThreadStatus =
  | "draft" | "sent" | "negotiating" | "agreed" | "to_ship" | "shipped" | "posted" | "declined" | "no_reply" | "closed";

/** Узгоджені умови: що й за скільки автор робить. */
export type ThreadTerms = { feeUsd: number | null; barter: boolean; deliverables: string; deadlineDays: number };
export type PostCheck = { checkedAt: string; found: boolean; url?: string; disclosure?: boolean; tags?: string[]; note?: string; videos?: number };

/** Листування з автором від імені клієнта: один ланцюжок на пару «автор — клієнт». */
export const outreachThreads = pgTable(
  "outreach_threads",
  {
    id: serial("id").primaryKey(),
    creatorId: integer("creator_id").notNull().references(() => creators.id, { onDelete: "cascade" }),
    clientId: integer("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    searchId: integer("search_id").references(() => searches.id, { onDelete: "set null" }),
    /** Скринька, з якої ведеться листування: відповіді йдуть з тієї самої адреси. */
    mailboxId: integer("mailbox_id").references(() => mailboxes.id, { onDelete: "set null" }),
    toEmail: text("to_email").notNull(),
    subject: text("subject").notNull(),
    language: text("language").notNull().default("en"),
    status: text("status").$type<ThreadStatus>().notNull().default("draft"),
    /** Чому потрібна людина (питання поза правилами, ставка понад стелю тощо); null — ІІ веде сам. */
    needsHuman: text("needs_human"),
    /** Питання автора, на які в правилах немає відповіді. */
    openQuestions: jsonb("open_questions").$type<string[]>().notNull().default([]),
    rounds: integer("rounds").notNull().default(0),
    /** Остання ставка, яку назвав автор, і остання наша пропозиція, $. */
    askedFeeUsd: doublePrecision("asked_fee_usd"),
    offeredFeeUsd: doublePrecision("offered_fee_usd"),
    terms: jsonb("terms").$type<ThreadTerms>(),
    /** Адреса доставки — особисті дані: видаляється разом з автором. */
    shipping: text("shipping"),
    followups: integer("followups").notNull().default(0),
    /** Коли наступна автоматична дія: нагадування чи перевірка допису. */
    nextActionAt: ts("next_action_at"),
    agreedAt: ts("agreed_at"),
    shippedAt: ts("shipped_at"),
    postDueAt: ts("post_due_at"),
    postUrl: text("post_url"),
    postedAt: ts("posted_at"),
    postCheck: jsonb("post_check").$type<PostCheck>(),
    lastInboundAt: ts("last_inbound_at"),
    lastOutboundAt: ts("last_outbound_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("outreach_threads_pair_idx").on(t.creatorId, t.clientId),
    index("outreach_threads_status_idx").on(t.status, t.nextActionAt),
  ],
).enableRLS();

export type MessageKind = "first" | "reply" | "followup" | "manual" | "inbound";
export type MessageStatus = "draft" | "queued" | "sent" | "failed" | "received" | "discarded";

export const outreachMessages = pgTable(
  "outreach_messages",
  {
    id: serial("id").primaryKey(),
    threadId: integer("thread_id").notNull().references(() => outreachThreads.id, { onDelete: "cascade" }),
    mailboxId: integer("mailbox_id").references(() => mailboxes.id, { onDelete: "set null" }),
    direction: text("direction").$type<"in" | "out">().notNull(),
    kind: text("kind").$type<MessageKind>().notNull(),
    status: text("status").$type<MessageStatus>().notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    /** Message-ID листа: за ним відповіді знаходять свій ланцюжок. */
    messageId: text("message_id"),
    inReplyTo: text("in_reply_to"),
    fromEmail: text("from_email"),
    toEmail: text("to_email"),
    /** Розбір вхідного листа моделлю або рішення й перевірка для вихідного. */
    ai: jsonb("ai").$type<Record<string, unknown>>(),
    issues: jsonb("issues").$type<string[]>().notNull().default([]),
    error: text("error"),
    sentAt: ts("sent_at"),
    receivedAt: ts("received_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("outreach_messages_thread_idx").on(t.threadId, t.createdAt),
    index("outreach_messages_status_idx").on(t.status, t.mailboxId),
    uniqueIndex("outreach_messages_mid_idx").on(t.messageId),
  ],
).enableRLS();

export type Client = typeof clients.$inferSelect;
export type Mailbox = typeof mailboxes.$inferSelect;
export type OutreachThread = typeof outreachThreads.$inferSelect;
export type OutreachMessage = typeof outreachMessages.$inferSelect;

/* ---------- Відгук на замовлення (Upwork тощо) ---------- */

/** Розбір тексту замовлення: кожен факт — з дослівною цитатою з нього. */
export type JobAnalysis = {
  title: string;
  /** Що хоче замовник — українською, щоб не перекладати самому. */
  summaryUk: string;
  /** find_creators і manage_outreach — ваша робота; be_a_creator — шукають самого автора контенту. */
  jobType: "find_creators" | "manage_outreach" | "be_a_creator" | "other";
  platform: "instagram" | "tiktok" | "both" | "unknown";
  focus: "ugc" | "affiliate";
  niche: string;
  creatorsNeeded: { count: number; quote: string } | null;
  /** Діапазон підписників із замовлення (5k–60k): ним обмежуємо пошук і приклади. */
  followers?: { min: number | null; max: number | null; quote: string } | null;
  budget: { amount: number; kind: "fixed" | "hourly" | "unknown"; quote: string } | null;
  requirements: { text: string; quote: string }[];
  redFlags: { text: string; quote: string }[];
  questions: string[];
  dropped: number;
};

/** Ваші дані для відгуку: модель не додає досвіду чи цифр понад те, що тут написано. */
export type PitchProfile = {
  name: string; about: string; offer: string;
  /** 2–3 ваші справжні повідомлення англійською: модель підлаштовує під них тон і простоту (фактів з них не бере). */
  style?: string;
};

/** Як обробити відгук із черги (кілька замовлень вставлено разом). */
export type PitchOptions = { platform: "auto" | "instagram" | "tiktok"; search: boolean };

/** Автор-приклад у відгуку: без email — контакти віддаємо лише після замовлення. */
export type PitchSample = {
  creatorId: number; handle: string; platform: string; url: string;
  followers: number | null; followersShort: string | null; erPct: string | null; country: string | null; hasEmail: boolean; why: string | null;
};

export const jobPitches = pgTable("job_pitches", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  jobText: text("job_text").notNull(),
  profile: jsonb("profile").$type<PitchProfile>().notNull(),
  analysis: jsonb("analysis").$type<JobAnalysis>(),
  proposal: text("proposal"),
  /** Переклад відгуку українською — щоб ви розуміли, що надсилаєте. */
  proposalUk: text("proposal_uk"),
  issues: jsonb("issues").$type<string[]>().notNull().default([]),
  samples: jsonb("samples").$type<PitchSample[]>().notNull().default([]),
  searchId: integer("search_id").references(() => searches.id, { onDelete: "set null" }),
  /** Відгук у черзі (кілька замовлень вставлено разом): фоновий виконавець розбере його, коли модель вільна. */
  options: jsonb("options").$type<PitchOptions>(),
  /** Ви вже відправили відгук і чим закінчилось — для статистики відгуків. */
  status: text("status").$type<"draft" | "sent" | "replied" | "won" | "lost">().notNull().default("draft"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}).enableRLS();

export type JobPitch = typeof jobPitches.$inferSelect;

/* ---------- Замовлення: переписка з клієнтом → завдання на пошук ---------- */

export type OrderMessage = { from: "client" | "me"; text: string; at: string };

/** Завдання на пошук, зібране з переписки. Кожне значення клієнта — з дослівною цитатою (quotes[поле]). */
export type OrderSpec = {
  summaryUk: string;
  /** Останнє повідомлення клієнта українською. */
  lastMessageUk: string;
  brand: string | null;
  niche: string | null;
  website: string | null;
  platform: "instagram" | "tiktok" | "both" | null;
  focus: "ugc" | "affiliate";
  count: number | null;
  /** "any" — клієнт сказав, що країна не важлива. */
  countries: string[] | "any" | null;
  languages: string[];
  followersMin: number | null;
  followersMax: number | null;
  mustHave: string[];
  exclude: string[];
  deadline: string | null;
  deliverable: string | null;
  wantsOutreach: boolean | null;
  budget: { amount: number; kind: "fixed" | "hourly" | "unknown" } | null;
  quotes: Record<string, string>;
  dropped: number;
};

/** Питання клієнта, на яке ІІ не знайшов відповіді у ваших даних, — чекає вас. */
export type OrderQuestion = { question: string; questionUk: string; quote: string };

export type OrderStatus = "clarifying" | "needs_you" | "ready" | "searching" | "reviewing" | "results" | "delivered" | "closed";
export type OrderDraftKind = "clarify" | "confirm" | "deliver" | "nudge";

/** Перевірка автора перед здачею: «підходить» іде клієнту, «сумнівно» — вам на рішення, «ні» — відсіяно. */
export type ReviewItem = {
  creatorId: number; handle: string; platform: string;
  verdict: "fits" | "no" | "unsure";
  /** Коротко англійською — у файл клієнту («чому підходить»). */
  reason: string;
  reasonUk: string;
  quote: string | null;
  by: "code" | "ai" | "you";
};

export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  pitchId: integer("pitch_id").references(() => jobPitches.id, { onDelete: "set null" }),
  clientId: integer("client_id").references(() => clients.id, { onDelete: "set null" }),
  profile: jsonb("profile").$type<PitchProfile>().notNull(),
  messages: jsonb("messages").$type<OrderMessage[]>().notNull().default([]),
  spec: jsonb("spec").$type<OrderSpec>(),
  /** Про які поля вже питали клієнта: необов’язкові вдруге не питаємо, а беремо типові. */
  asked: jsonb("asked").$type<string[]>().notNull().default([]),
  /** Ваші підказки для відповіді (можна українською): ціна, строк, що завгодно. */
  notes: text("notes"),
  pending: jsonb("pending").$type<OrderQuestion[]>().notNull().default([]),
  draft: text("draft"),
  draftUk: text("draft_uk"),
  draftKind: text("draft_kind").$type<OrderDraftKind>(),
  /** Які поля питає чернетка: після «Надіслав» вони вважаються запитаними. */
  draftAsks: jsonb("draft_asks").$type<string[]>().notNull().default([]),
  draftIssues: jsonb("draft_issues").$type<string[]>().notNull().default([]),
  searchIds: jsonb("search_ids").$type<number[]>().notNull().default([]),
  /** Перевірка списку перед здачею. */
  review: jsonb("review").$type<ReviewItem[]>().notNull().default([]),
  /** Скільки разів пошук автоматично добирав авторів, коли підходящих не вистачило. */
  topUps: integer("top_ups").notNull().default(0),
  status: text("status").$type<OrderStatus>().notNull().default("clarifying"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}).enableRLS();

export type Order = typeof orders.$inferSelect;

/* ---------- Бренди для креаторів: хто вже платить авторам у ніші ---------- */

/** Доказ співпраці: рекламний допис автора з відміткою бренду. */
export type BrandCollab = { creator: string; followers: number | null; postUrl: string; reason: string; paid: boolean; at: string | null };
export type BrandVerdict = "brand" | "not_brand" | "unsure";
export type BrandLead = {
  handle: string;
  name: string | null;
  bio: string | null;
  category: string | null;
  followers: number | null;
  website: string | null;
  email: string | null;
  /** Звідки email: біо чи сторінка сайту. */
  emailSource: string | null;
  verdict: BrandVerdict;
  verdictWhy: string;
  /** Ви змінили вердикт вручну. */
  byYou?: boolean;
  collabs: BrandCollab[];
  pitch?: { subject: string; body: string; bodyUk: string; issues: string[] } | null;
};
/** Креатор, якому шукаємо бренди: з цього пишуться листи (модель не додасть нічого понад це). */
export type BrandCreator = { name: string; handle: string; niche: string; followers: string; about: string; portfolio: string; offer: string; style?: string };
export type BrandScoutStats = { posts: number; creators: number; adPosts: number; candidates: number; brandProfiles: number; withEmail: number; costUsd: number; notes: string[] };

export const brandScouts = pgTable("brand_scouts", {
  id: serial("id").primaryKey(),
  niche: text("niche").notNull(),
  hashtags: jsonb("hashtags").$type<string[]>().notNull().default([]),
  postsPerTag: integer("posts_per_tag").notNull().default(40),
  maxCreators: integer("max_creators").notNull().default(60),
  maxBrands: integer("max_brands").notNull().default(40),
  status: text("status").$type<"queued" | "running" | "done" | "failed">().notNull().default("queued"),
  stage: text("stage"),
  stats: jsonb("stats").$type<Partial<BrandScoutStats>>().notNull().default({}),
  brands: jsonb("brands").$type<BrandLead[]>().notNull().default([]),
  creator: jsonb("creator").$type<BrandCreator>(),
  /** Бренди, яким фоновий виконавець має написати листи (по одному за раз через ліміти моделі). */
  pitchQueue: jsonb("pitch_queue").$type<string[]>().notNull().default([]),
  error: text("error"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}).enableRLS();

export type BrandScout = typeof brandScouts.$inferSelect;
