import { readFile } from "node:fs/promises";
import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { analyzeAds, adsReasons, type AdsReport } from "@/analysis/ads";
import { recordCreatorAds } from "@/brands/collabs";
import { analyzeComments, commentMetrics } from "@/analysis/comments";
import { mergePosts, postFactsFromRaw, postMetrics, profilePosts, type CommentFacts, type PostFacts } from "@/analysis/posts";
import { analyzeProfile, profileVerdict, PROFILE_PROMPT_VERSION, type ProfileAnalysis } from "@/analysis/profile";
import { assessTrust, loadNorms, type Norms, type Risk, type Snapshot, type TrustReport } from "@/analysis/trust";
import { adQualityIndex, deepAudit, DEEP_VERSION, type DeepAudit } from "@/audit/deep";
import { auditCreator, AUDIT_VERSION, collagePath, scoreCollage, type VisionAudit } from "@/audit/vision";
import { collect, collectProfiles } from "@/collect";
import type { ContentItem } from "@/core/contract";
import type { Db } from "@/db/client";
import {
  contentItems, creatorContacts, creators, creatorSnapshots, searchCandidates, searches,
  type Creator, type Search, type SearchProgress, type SearchStats, type SourceStats,
} from "@/db/schema";
import { activityOf, activityStatus } from "@/enrich/activity";
import { detectCountry, detectLanguage } from "@/enrich/geo";
import { classifyLinks } from "@/enrich/links";
import { LlmUnavailableError } from "@/llm/client";
import { criteriaOf, DEFAULT_CRITERIA, evaluateCriteria, weightedScore, weightsOf, type CreatorFacts } from "./criteria";
import { enrichCreator } from "./enrich";
import { readinessIndex, scoreCandidate } from "./signals";
import { expansionTags, planSources, PRICE, seedTags, sourcesOf, type Found, type SourceTask } from "./sources";
import { suppressedSet, usernameKey } from "./suppress";

/** Приблизна ціна одного результату актора Apify, $. */
export const PRICE_PER_RESULT_USD = PRICE.post;
const DAY = 86_400_000;
/** Профіль і сторінки-візитки, зібрані не давніше цього, повторно не запитуємо. */
const PROFILE_FRESH_MS = 7 * DAY;
const LINKS_FRESH_MS = 7 * DAY;
const AUDIT_FRESH_MS = 30 * DAY;
const COMMENTS_FRESH_MS = 30 * DAY;
/** Пам’ять відмов: магазин чи закритий профіль не перевіряємо (і не оплачуємо) знову 90 днів. */
const HARD_REJECT_MS = 90 * DAY;
const PROFILE_CHUNK = 50;
/**
 * Скільки авторів за пошук читає модель-аналітик: на 10 більше, ніж візуальних аудитів. Безкоштовний
 * Groq дає ~1000 вихідних токенів на хвилину (3–4 профілі), тож більше — це вже десятки хвилин.
 */
const analysisLimit = (auditLimit: number) => Math.max(10, auditLimit + 10);
const COMMENT_POSTS = 3;
const COMMENTS_PER_POST = 10;
/** Оцінка ближче за цю відстань до порога — «біля порога»: потрібна друга думка або ваш погляд. */
const BORDER = 7;
const MAX_EXPANSIONS = 2;
/** Пороги якості за замовчуванням: нижче MIN — відхиляємо, від LEAD — «готовий лід». */
export const QUALITY_MIN = DEFAULT_CRITERIA.quality.min;
export const QUALITY_LEAD = DEFAULT_CRITERIA.quality.lead;

/** Оцінка максимальних витрат Apify: усі джерела, усі профілі й платні коментарі (або бюджет, якщо він менший). */
export function estimateCostUsd(s: Search): number {
  if (s.platform === "tiktok") return 0; // профілі TikTok — з публічних сторінок, без Apify
  const sources = planSources(s).reduce((a, t) => a + t.estimateUsd, 0);
  const seeds = sourcesOf(s).seeds.length * PRICE.profile;
  const comments = s.commentsLimit * COMMENT_POSTS * COMMENTS_PER_POST * PRICE.comment;
  const total = sources + seeds + s.maxProfiles * PRICE.profile + comments;
  return Math.round(Math.min(total, s.budgetUsd ?? Infinity) * 100) / 100;
}

class Cancelled extends Error {}

async function setProgress(db: Db, id: number, progress: SearchProgress, stats?: SearchStats) {
  const [row] = await db.update(searches).set({ progress, ...(stats ? { stats } : {}) }).where(eq(searches.id, id)).returning({ status: searches.status });
  if (row?.status === "cancelled") throw new Cancelled();
}

const postText = (p: ContentItem) => [p.text ?? "", p.tags.map((t) => `#${t}`).join(" ")].join("\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mapLimit<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  }));
}

const EMAIL_RANK: Record<string, number> = { personal: 4, business: 3, unknown: 2, role: 1 };
const RISK_LABEL: Record<Risk, string> = { low: "низький", medium: "середній", high: "високий", unknown: "невідомий" };

type Author = Found & { source: string };
type Ctx = {
  db: Db;
  search: Search;
  criteria: ReturnType<typeof criteriaOf>;
  weights: ReturnType<typeof weightsOf>;
  stats: SearchStats;
  now: Date;
  norms: Norms;
  spent: number;
  budget: number | null;
  left: { shortlist: number; audits: number; deep: number; comments: number; analysis: number };
  examples?: string;
  authors: Map<string, Author>;
  /** Автори з попередніх запусків цієї серії (повторний пошук показує лише нових). */
  series: Set<string>;
  qualified: Set<string>;
  /** Уже оцінені в попередніх хвилях. */
  done: Set<string>;
  llmDown: string | null;
  notes: string[];
};

const canSpend = (ctx: Ctx, usd: number) => ctx.budget == null || ctx.spent + usd <= ctx.budget + 1e-9;

function sourceStats(ctx: Ctx, label: string): SourceStats {
  ctx.stats.bySource ??= {};
  return (ctx.stats.bySource[label] ??= { authors: 0, qualified: 0, leads: 0, costUsd: 0 });
}

function charge(ctx: Ctx, usd: number, label?: string) {
  if (!usd) return;
  ctx.spent += usd;
  ctx.stats.costUsd = Math.round(ctx.spent * 10000) / 10000;
  if (label) sourceStats(ctx, label).costUsd = Math.round((sourceStats(ctx, label).costUsd + usd) * 10000) / 10000;
}

/**
 * Запит до мовної моделі з урахуванням лімітів: коротка пауза, якщо ліміт хвилинний; якщо моделі
 * недоступні надовго — решта кроків із моделлю пропускається, а пошук іде далі без них.
 */
async function withLlm<T>(ctx: Ctx, fn: () => Promise<T>): Promise<T | Error | null> {
  if (ctx.llmDown) return null;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      // Хвилинний ліміт — чекаємо й повторюємо; якщо модель недоступна надовго — пропускаємо кроки з нею.
      if (e instanceof LlmUnavailableError && e.retryAt && e.retryAt.getTime() - Date.now() < 90_000 && attempt < 5) {
        await sleep(Math.max(1000, e.retryAt.getTime() - Date.now() + 500));
        continue;
      }
      if (e instanceof LlmUnavailableError) {
        ctx.llmDown = e.message;
        return null;
      }
      return e instanceof Error ? e : new Error(String(e));
    }
  }
}

/** Ваші минулі рішення як орієнтир для моделі: що ви брали і що відхиляли. */
async function verdictExamples(db: Db): Promise<string | undefined> {
  const rows = await db.select({ v: creators.manualVerdict, audit: creators.audit }).from(creators)
    .where(and(isNotNull(creators.manualVerdict), eq(creators.auditVersion, AUDIT_VERSION))).limit(200);
  const line = (a: Record<string, unknown> | null) => {
    const au = a as VisionAudit | null;
    if (!au?.summary) return null;
    const s = au.scores ? Object.entries(au.scores).map(([k, v]) => `${k} ${v.score ?? "?"}`).join(", ") : "";
    return `- ${au.aesthetic ? `${au.aesthetic}: ` : ""}${au.summary} (${s})`;
  };
  const yes = rows.filter((r) => r.v === "yes").map((r) => line(r.audit)).filter(Boolean).slice(0, 3);
  const no = rows.filter((r) => r.v === "no").map((r) => line(r.audit)).filter(Boolean).slice(0, 3);
  if (!yes.length || !no.length) return undefined;
  return `For calibration, this team's past decisions on other creators (match their bar, do not copy the text):\nACCEPTED:\n${yes.join("\n")}\nREJECTED:\n${no.join("\n")}`;
}

/** Імена авторів, що вже були кандидатами в попередніх запусках цієї серії. */
async function seriesUsernames(db: Db, search: Search): Promise<Set<string>> {
  const ids: number[] = [];
  let parent = search.parentId;
  for (let i = 0; parent && i < 50; i++) {
    ids.push(parent);
    const [p] = await db.select({ parentId: searches.parentId }).from(searches).where(eq(searches.id, parent));
    parent = p?.parentId ?? null;
  }
  // Пошуки-«брати»: усі, кого той самий батько породив раніше.
  if (search.parentId) {
    const siblings = await db.select({ id: searches.id }).from(searches).where(and(eq(searches.parentId, search.parentId), sql`${searches.id} < ${search.id}`));
    ids.push(...siblings.map((s) => s.id));
  }
  if (!ids.length) return new Set();
  const rows = await db.select({ username: creators.username }).from(searchCandidates)
    .innerJoin(creators, eq(searchCandidates.creatorId, creators.id)).where(inArray(searchCandidates.searchId, ids));
  return new Set(rows.map((r) => r.username));
}

/**
 * Воронка пошуку хвилями: джерела (хештеги, пошук за біо, відмітки брендів, місця, веб, список)
 * → безкоштовний відбір за текстом → профілі (платно) → цифри, довіра, реклама → аналіз тексту
 * моделлю → контакти → візуальний аудит → глибокий аудит роликів → коментарі → підсумок.
 * Якщо задано мету за лідами чи бюджет, джерела запускаються по одному, і пошук зупиняється, щойно
 * мети досягнуто; коли джерела закінчились, а мета ні — додаються хештеги, знайдені в дописах
 * авторів, що пройшли відбір. Кроки кешуються, тож перерваний пошук можна просто запустити знову.
 */
export async function runSearch(db: Db, searchId: number): Promise<void> {
  const [search] = await db.select().from(searches).where(eq(searches.id, searchId));
  if (!search) return;
  const ctx: Ctx = {
    db, search, criteria: criteriaOf(search), weights: weightsOf(search), stats: { posts: 0 }, now: new Date(), norms: await loadNorms(db),
    spent: 0, budget: search.budgetUsd ?? null,
    left: { shortlist: search.maxProfiles, audits: search.auditLimit, deep: search.deepLimit, comments: search.commentsLimit, analysis: analysisLimit(search.auditLimit) },
    authors: new Map(), series: new Set(), qualified: new Set(), done: new Set(), llmDown: null, notes: [],
  };
  const { stats } = ctx;
  try {
    ctx.series = await seriesUsernames(db, search);
    ctx.examples = await verdictExamples(db);
    const used = new Set(search.hashtags);
    const extraTags: string[] = [];
    const seeds = search.platform === "tiktok" ? [] : sourcesOf(search).seeds;
    if (search.platform === "tiktok") {
      const src = sourcesOf(search);
      const unsupported = [src.seeds.length && "схожі на зразки", src.competitors.length && "відмітки брендів", src.places.length && "місця"].filter(Boolean);
      if (unsupported.length) ctx.notes.push(`TikTok: ${unsupported.join(", ")} не підтримуються — TikTok віддає їх лише своєму застосунку`);
      ctx.notes.push("TikTok: профілі зібрано безкоштовно з публічних сторінок; ролики й коментарі недоступні, тож візуальний аудит і розбір роликів не виконуються");
    }
    if (seeds.length) {
      if (canSpend(ctx, seeds.length * PRICE.profile)) {
        await setProgress(db, searchId, { stage: "Вивчаю авторів-зразків", done: 0, total: seeds.length }, stats);
        try {
          const r = await seedTags(db, seeds, used);
          charge(ctx, r.costUsd, "схожі на зразки");
          extraTags.push(...r.tags);
          r.tags.forEach((t) => used.add(t));
          ctx.notes.push(r.tags.length ? `Хештеги зразків: ${r.tags.map((t) => `#${t}`).join(" ")}` : "У зразків не знайшлося спільних хештегів");
        } catch (e) {
          ctx.notes.push(`Зразки: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
        }
      } else ctx.notes.push("Зразки пропущено: не вистачає бюджету");
    }

    const queue: SourceTask[] = planSources(search, extraTags).map((t) => (extraTags.some((x) => t.label === `#${x}`) ? { ...t, label: `${t.label} (схожі на зразки)` } : t));
    const autopilot = search.targetLeads != null;
    const errors: string[] = [];
    let ran = 0;
    let expansions = 0;
    stats.waves = 0;

    while (queue.length) {
      // Без мети — одна хвиля з усіма джерелами; з метою — по джерелу, щоб зупинитися якомога раніше.
      const wave = autopilot ? queue.splice(0, 1) : queue.splice(0);
      for (const [i, task] of wave.entries()) {
        if (!canSpend(ctx, task.estimateUsd)) {
          ctx.notes.push(`${task.label}: пропущено — не вистачає бюджету`);
          continue;
        }
        await setProgress(db, searchId, { stage: `Збираю: ${task.label}`, done: i, total: wave.length }, stats);
        try {
          const r = await task.run(db);
          ran++;
          charge(ctx, r.costUsd, task.label);
          stats.posts = (stats.posts ?? 0) + r.posts;
          ctx.notes.push(...r.notes);
          for (const f of r.found) {
            const prev = ctx.authors.get(f.username);
            if (prev) {
              for (const p of f.posts) if (!prev.posts.some((x) => x.id === p.id)) prev.posts.push(p);
            } else ctx.authors.set(f.username, { ...f, source: task.label });
          }
        } catch (e) {
          errors.push(`${task.label}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const fresh = [...ctx.authors.keys()].filter((u) => !ctx.done.has(u));
      if (fresh.length) {
        await evaluate(ctx, fresh);
        stats.waves++;
      }
      fresh.forEach((u) => ctx.done.add(u));
      if (autopilot && (stats.leads ?? 0) >= search.targetLeads!) {
        ctx.notes.push(`Мету досягнуто: ${stats.leads} готових лідів`);
        break;
      }
      if (autopilot && !queue.length && expansions < MAX_EXPANSIONS && ctx.qualified.size) {
        const tags = expansionTags([...ctx.qualified].map((u) => ctx.authors.get(u)?.posts.map((p) => p.item) ?? []), used, search.stopWords);
        if (tags.length) {
          expansions++;
          tags.forEach((t) => used.add(t));
          stats.expandedTags = [...(stats.expandedTags ?? []), ...tags];
          queue.push(...planSources({ ...search, hashtags: tags, sources: {} }).map((t) => ({ ...t, label: `${t.label} (знайдено в дописах)` })));
        }
      }
    }
    if (ran === 0 && errors.length) throw new Error(errors.join("; ").slice(0, 2000));
    if (autopilot && (stats.leads ?? 0) < search.targetLeads!) ctx.notes.push(`Мету не досягнуто: ${stats.leads ?? 0} з ${search.targetLeads} лідів`);
    ctx.notes.push(...errors.map((e) => e.slice(0, 300)));
    if (ctx.llmDown) {
      stats.note = `Мовна модель недоступна: ${ctx.llmDown.slice(0, 200)}. Аналіз тексту й візуальний аудит зупинено — запустіть пошук знову пізніше, уже оцінені автори не перераховуються.`;
    }
    stats.authors = ctx.authors.size;
    stats.notes = ctx.notes.slice(0, 30);
    await db.update(searches).set({ status: "done", stats, finishedAt: new Date(), progress: null, error: null }).where(eq(searches.id, searchId));
  } catch (e) {
    stats.authors = ctx.authors.size;
    stats.notes = ctx.notes.slice(0, 30);
    if (e instanceof Cancelled) {
      await db.update(searches).set({ finishedAt: new Date(), progress: null, stats }).where(eq(searches.id, searchId));
      return;
    }
    await db.update(searches)
      .set({ status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 2000), finishedAt: new Date(), progress: null, stats })
      .where(eq(searches.id, searchId));
  }
}

type Row = {
  c: Creator;
  source: string;
  fit: number;
  reasons: string[];
  reject: string[];
  posts: PostFacts[];
  covers: string[];
  videos: string[];
  ads: AdsReport | null;
  trust: TrustReport | null;
  comments: CommentFacts[];
};

/** Оцінка нових авторів однієї хвилі — від безкоштовних кроків до платних. */
async function evaluate(ctx: Ctx, names: string[]): Promise<void> {
  const { db, search, stats, now } = ctx;
  const scoreArgs = { keywords: search.keywords, stopWords: search.stopWords, ignoreTags: search.hashtags, focus: search.focus };

  // 1. Список виключень: таких авторів не створюємо й не показуємо взагалі.
  const suppressed = await suppressedSet(db, names.map((u) => usernameKey(search.platform, u)));
  names = names.filter((u) => !suppressed.has(usernameKey(search.platform, u)));
  if (!names.length) return;
  for (let i = 0; i < names.length; i += 200) {
    await db.insert(creators)
      .values(names.slice(i, i + 200).map((username) => ({
        platform: search.platform, username, displayName: ctx.authors.get(username)!.displayName ?? null, externalId: ctx.authors.get(username)!.externalId ?? null,
      })))
      .onConflictDoNothing({ target: [creators.platform, creators.username] });
  }
  const load = async (usernames: string[]) =>
    usernames.length ? db.select().from(creators).where(and(eq(creators.platform, search.platform), inArray(creators.username, usernames))) : [];
  const creatorBy = new Map((await load(names)).map((c) => [c.username, c]));
  const textsOf = (u: string) => ctx.authors.get(u)!.posts.map((p) => postText(p.item));

  // 2. Безкоштовний відбір: відомі відмови, уже в роботі, попередні запуски серії, текст дописів і біо.
  const known = (c: Creator): string | null => {
    if (ctx.series.has(c.username)) return "вже був у попередньому запуску цього пошуку";
    if (search.excludeContacted && c.outreachStatus !== "new") return `уже в роботі (${c.outreachStatus})`;
    if (c.hardReject && c.hardRejectAt && now.getTime() - c.hardRejectAt.getTime() < HARD_REJECT_MS) return `раніше відхилено: ${c.hardReject}`;
    return null;
  };
  const scored = names.map((username) => {
    const c = creatorBy.get(username)!;
    const s = scoreCandidate({ ...scoreArgs, texts: textsOf(username), bio: c.bio, affiliate: c.affiliate, names: [c.username, c.displayName] });
    return { username, c, known: known(c), postIds: ctx.authors.get(username)!.posts.map((p) => p.id), source: ctx.authors.get(username)!.source, ...s };
  });
  scored.sort((a, b) => b.fit - a.fit || b.postIds.length - a.postIds.length || a.username.localeCompare(b.username));
  const eligible = scored.filter((s) => !s.known && !s.blocked && !s.negative);
  const shortlist = eligible.slice(0, Math.max(0, ctx.left.shortlist));
  ctx.left.shortlist -= shortlist.length;
  const shortSet = new Set(shortlist.map((s) => s.username));
  stats.shortlisted = (stats.shortlisted ?? 0) + shortlist.length;
  stats.skippedKnown = (stats.skippedKnown ?? 0) + scored.filter((s) => s.known?.startsWith("раніше")).length;
  for (const s of scored) sourceStats(ctx, s.source).authors++;

  for (let i = 0; i < scored.length; i += 200) {
    await db.insert(searchCandidates)
      .values(scored.slice(i, i + 200).map((s) => ({
        searchId: search.id, creatorId: s.c.id, postIds: s.postIds, fit: s.fit, score: s.fit, source: s.source,
        stage: shortSet.has(s.username) ? ("shortlisted" as const) : ("filtered_out" as const),
        reasons: shortSet.has(s.username)
          ? s.reasons
          : [...s.reasons, s.known ?? (s.blocked ? "відсіяно стоп-словом" : s.negative ? "відсіяно за текстом дописів" : "не увійшов до ліміту профілів")],
      })))
      .onConflictDoUpdate({
        target: [searchCandidates.searchId, searchCandidates.creatorId],
        set: {
          postIds: sql`excluded.post_ids`, fit: sql`excluded.fit`, readiness: sql`null`, quality: sql`null`, trust: sql`null`, match: sql`null`, lead: sql`false`,
          score: sql`excluded.score`, stage: sql`excluded.stage`, reasons: sql`excluded.reasons`, source: sql`excluded.source`,
        },
      });
  }
  if (!shortlist.length) return;

  // 3. Профілі — лише для відібраних і лише тих, кого давно не збирали; у межах бюджету.
  const freshAfter = new Date(now.getTime() - PROFILE_FRESH_MS);
  let need = shortlist.filter((s) => !s.c.profileFetchedAt || s.c.profileFetchedAt < freshAfter).map((s) => s.username);
  const tiktok = search.platform === "tiktok";
  const affordable = ctx.budget == null || tiktok ? need.length : Math.max(0, Math.floor((ctx.budget - ctx.spent) / PRICE.profile + 1e-9));
  const unpaid = new Set(need.slice(affordable));
  if (unpaid.size) ctx.notes.push(`Не вистачило бюджету на ${unpaid.size} профілів`);
  need = need.slice(0, affordable);
  stats.profilesReused = (stats.profilesReused ?? 0) + shortlist.length - need.length - unpaid.size;
  stats.profilesFetched ??= 0;
  const rawProfiles = new Map<string, any>();
  /** Зібрані в цьому проході (на відміну від узятих із кешу) — лише їх записуємо як свіжі. */
  const fetched = new Set<string>();
  for (let i = 0; i < need.length; i += PROFILE_CHUNK) {
    await setProgress(db, search.id, { stage: "Збираю профілі відібраних авторів", done: i, total: need.length }, stats);
    const chunk = need.slice(i, i + PROFILE_CHUNK);
    const { batch } = await collectProfiles(db, chunk, { platform: search.platform });
    if ((batch as { limited?: boolean }).limited) ctx.notes.push("TikTok тимчасово обмежив запити — частину профілів не зібрано, запустіть пошук знову пізніше");
    const each = (batch.costUsd ?? chunk.length * PRICE.profile) / chunk.length;
    for (const u of chunk) charge(ctx, each, ctx.authors.get(u)?.source);
    const seen = new Set<string>();
    for (const { item, raw } of batch.collected) {
      if (item.kind !== "profile" || !item.author?.username) continue;
      const username = item.author.username.toLowerCase();
      seen.add(username);
      rawProfiles.set(username, raw);
      fetched.add(username);
      stats.profilesFetched++;
    }
    // Профіль не повернувся (видалений, перейменований): позначаємо, щоб не питати щоразу.
    const missing = chunk.filter((u) => !seen.has(u));
    if (missing.length) {
      await db.update(creators).set({ profileFetchedAt: now, updatedAt: now })
        .where(and(eq(creators.platform, search.platform), inArray(creators.username, missing), sql`${creators.followers} is null`));
    }
  }
  // Сирі профілі з кешу — для тих, кого не збирали зараз.
  const reuse = shortlist.map((s) => s.username).filter((u) => !rawProfiles.has(u));
  if (reuse.length) {
    const rows = await db.select({ ext: contentItems.externalId, raw: contentItems.raw }).from(contentItems)
      .where(and(eq(contentItems.source, search.platform), inArray(contentItems.externalId, reuse.map((u) => `profile:${u}`))));
    for (const r of rows) if (r.raw) rawProfiles.set(r.ext.slice("profile:".length), r.raw);
  }
  // Сирі дописи з джерел (у них бувають позначка партнерства, відмітки, коментарі).
  const postIds = shortlist.flatMap((s) => s.postIds);
  const rawPosts = new Map<number, unknown>();
  for (let i = 0; i < postIds.length; i += 500) {
    const rows = await db.select({ id: contentItems.id, raw: contentItems.raw }).from(contentItems).where(inArray(contentItems.id, postIds.slice(i, i + 500)));
    rows.forEach((r) => rawPosts.set(r.id, r.raw));
  }

  // 4. Цифри профілю, довіра до аудиторії, реклама — рахує код, безкоштовно.
  const rows: Row[] = [];
  for (const s of shortlist) {
    const raw = rawProfiles.get(s.username);
    const fromSources = s.postIds.map((id) => postFactsFromRaw(rawPosts.get(id))).filter((p): p is PostFacts => p != null && p.owner === s.username);
    const posts = mergePosts(raw ? profilePosts(raw) : [], fromSources);
    const c = raw && fetched.has(s.username) ? await applyProfile(ctx, s.c, raw, posts) : s.c;
    rows.push({
      c, source: s.source, fit: s.fit, reasons: [...s.reasons], reject: [], posts,
      covers: posts.map((p) => p.cover).filter((u): u is string => !!u),
      videos: posts.filter((p) => p.isVideo && p.videoUrl).map((p) => p.videoUrl!),
      ads: null, trust: null, comments: posts.flatMap((p) => p.latestComments.map((x) => ({ ...x, postUrl: x.postUrl ?? p.url }))),
    });
    if (unpaid.has(s.username) && !raw) rows.at(-1)!.reject.push("профіль не зібрано — не вистачило бюджету");
  }
  for (const row of rows) {
    const c = row.c;
    const s = scoreCandidate({ ...scoreArgs, texts: textsOf(c.username), bio: c.bio, affiliate: c.affiliate, names: [c.username, c.displayName] });
    row.fit = s.fit;
    row.reasons = s.reasons;
    if (row.reject.length) continue;
    if (c.followers == null && c.bio == null) await remember(ctx, row, "профіль не знайдено");
    else if (c.isPrivate) await remember(ctx, row, "закритий профіль");
    else if (s.negative) await remember(ctx, row, "не окремий автор (магазин, агенція чи платформа)");
    if (s.blocked) row.reject.push("відсіяно стоп-словом");
    if (row.reject.length) continue;
    row.ads = row.posts.length ? analyzeAds(row.posts, c.username, sourcesOf(search).competitors) : (c.ads as AdsReport | null);
    // Попутно: бренди з реклами автора — у базу брендів (дописи вже зібрані, тож безкоштовно).
    if (search.platform === "instagram" && row.posts.length) await recordCreatorAds(db, c, row.posts, search.id).catch(() => 0);
    row.trust = await trustOf(ctx, row, null);
    row.reject.push(...evaluateCriteria(ctx.criteria, search, factsOf(row, now)).reject);
  }

  // 5. Аналіз тексту профілю моделлю: хто це насправді, роль, ніші, мова, країна, відповідність брифу.
  const analyzeRows = rows.filter((r) => r.reject.length === 0);
  for (const [i, row] of analyzeRows.entries()) {
    const cached = row.c.analysis as ProfileAnalysis | null;
    // З брифом аналіз щоразу свій (кеш моделі однаково не дасть заплатити двічі за той самий бриф).
    const fresh = cached?.version === PROFILE_PROMPT_VERSION && !!row.c.analyzedAt && now.getTime() - row.c.analyzedAt.getTime() < AUDIT_FRESH_MS;
    let analysis: ProfileAnalysis | null = fresh && !search.brief ? cached : null;
    if (!analysis && ctx.left.analysis > 0 && !ctx.llmDown) {
      if (i % 5 === 0) await setProgress(db, search.id, { stage: "Читаю профілі (мовна модель)", done: i, total: analyzeRows.length }, stats);
      ctx.left.analysis--;
      const r = await withLlm(ctx, () => analyzeProfile(db, {
        username: row.c.username, displayName: row.c.displayName, bio: row.c.bio, posts: row.posts.length ? row.posts : textsOf(row.c.username).map((t) => ({ caption: t } as PostFacts)),
        brief: search.brief, focus: search.focus,
      }));
      if (r && !(r instanceof Error)) {
        analysis = r;
        const lang = row.c.language ?? r.language;
        const country = row.c.country ?? r.country?.value ?? null;
        const [u] = await db.update(creators).set({
          analysis: r as unknown as Record<string, unknown>, analyzedAt: now, language: lang, country,
          countryConfidence: row.c.country ? row.c.countryConfidence : r.country ? 0.7 : null, updatedAt: now,
        }).where(eq(creators.id, row.c.id)).returning();
        if (u) row.c = u;
        stats.analyzed = (stats.analyzed ?? 0) + 1;
      } else if (r instanceof Error) row.reasons.push(`аналіз тексту не вдався: ${r.message.slice(0, 80)}`);
    }
    if (!analysis && fresh) analysis = cached;
    if (!analysis) continue;
    const v = profileVerdict(analysis, search.focus);
    if (v.reject) await remember(ctx, row, v.reject);
    row.fit = Math.max(row.fit, v.fit);
    row.reasons.push(...v.reasons);
    // Мову й країну модель могла визначити там, де код не зміг.
    row.reject = row.reject.concat(evaluateCriteria(ctx.criteria, search, factsOf(row, now)).reject.filter((x) => !row.reject.includes(x)));
  }

  // 6. Сторінки-візитки та перевірка email (безкоштовно).
  const alive = rows.filter((r) => r.reject.length === 0);
  stats.linkPages ??= 0;
  let done = 0;
  const linksFreshAfter = new Date(now.getTime() - LINKS_FRESH_MS);
  await mapLimit(alive, 3, async (row) => {
    if (!row.c.linksCheckedAt || row.c.linksCheckedAt < linksFreshAfter || row.c.linksCheckedAt < (row.c.profileFetchedAt ?? row.c.linksCheckedAt)) {
      const r = await enrichCreator(db, row.c);
      row.c = r.creator;
      stats.linkPages! += r.pages;
    }
    if (++done % 5 === 0 || done === alive.length) {
      await setProgress(db, search.id, { stage: "Шукаю контакти на сторінках-візитках", done, total: alive.length }, stats);
    }
  });

  // 7. Попередній рейтинг: Fit, Readiness, Trust, відповідність «бажаним» критеріям.
  const contactRows = alive.length ? await db.select().from(creatorContacts).where(inArray(creatorContacts.creatorId, alive.map((r) => r.c.id))) : [];
  const bestEmailOf = (row: Row) =>
    contactRows.filter((k) => k.creatorId === row.c.id && row.c.emails.includes(k.email)).sort((a, b) => (EMAIL_RANK[b.status] ?? 0) - (EMAIL_RANK[a.status] ?? 0))[0]?.status ?? null;
  const readinessOf = (row: Row) => {
    const days = row.c.lastPostAt ? Math.floor((now.getTime() - row.c.lastPostAt.getTime()) / DAY) : null;
    return readinessIndex({
      emailStatus: bestEmailOf(row), daysSincePost: days, hasRate: row.c.rates.length > 0,
      hasPortfolio: row.c.portfolio.length > 0 || classifyLinks(row.c.links).hubs.length > 0,
    });
  };
  const prelim = (row: Row) => weightedScore(ctx.weights, {
    fit: row.fit, readiness: readinessOf(row).readiness, trust: row.trust?.score, match: evaluateCriteria(ctx.criteria, search, factsOf(row, now)).match,
  });
  alive.sort((a, b) => prelim(b) - prelim(a));

  // 8. Візуальний аудит найкращих; біля порога — друга думка іншої моделі або позначка «перегляньте».
  const auditFreshAfter = new Date(now.getTime() - AUDIT_FRESH_MS);
  // TikTok: кадрів безкоштовно не дістати — візуальний аудит не запускаємо.
  const toAudit = search.platform === "tiktok" ? [] : alive.slice(0, Math.max(0, ctx.left.audits));
  ctx.left.audits -= toAudit.length;
  stats.audited ??= 0;
  for (const [i, row] of toAudit.entries()) {
    if (row.c.auditedAt && row.c.auditedAt > auditFreshAfter && row.c.quality != null && row.c.auditVersion === AUDIT_VERSION) continue;
    if (ctx.llmDown) break;
    await setProgress(db, search.id, { stage: "Оцінюю якість візуалу", done: i, total: toAudit.length }, stats);
    const res = await withLlm(ctx, () => auditCreator(db, row.c.id, { covers: row.covers, videos: row.videos }, { examples: ctx.examples }));
    if (res == null) break;
    if (res instanceof Error) {
      row.reasons.push(`аудит не вдався: ${res.message.slice(0, 80)}`);
      continue;
    }
    if ("skipped" in res) {
      row.reasons.push(`аудит пропущено: ${res.skipped}`);
      continue;
    }
    let quality = res.quality;
    let review: string | null = null;
    const near = quality != null && [ctx.criteria.quality.min, ctx.criteria.quality.lead].some((t) => Math.abs(quality! - t) <= BORDER);
    if (near) {
      const collage = await readFile(collagePath(row.c.id)).catch(() => null);
      const second = collage ? await secondOpinion(ctx, collage, res.audit.frames, res.audit.fromVideo, res.provider) : null;
      if (second?.quality != null) {
        if (Math.abs(second.quality - quality!) > 15) review = `моделі розійшлися: ${quality} і ${second.quality} — перегляньте вручну`;
        quality = Math.round((quality! + second.quality) / 2);
      } else review = `оцінка ${quality} біля порога — перегляньте вручну`;
    }
    const [u] = await db.update(creators)
      .set({ quality, audit: res.audit as unknown as Record<string, unknown>, auditedAt: now, auditVersion: AUDIT_VERSION, reviewNote: review })
      .where(eq(creators.id, row.c.id)).returning();
    if (u) row.c = u;
    stats.audited++;
  }

  // 9. Глибокий аудит роликів (рекламна подача, мовлення) — для найкращих, хто пройшов поріг якості.
  const deepCandidates = alive.filter((r) => r.c.quality != null && r.c.quality >= ctx.criteria.quality.min && r.videos.length > 0);
  const toDeep = deepCandidates.slice(0, Math.max(0, ctx.left.deep));
  ctx.left.deep -= toDeep.length;
  stats.deepAudited ??= 0;
  for (const [i, row] of toDeep.entries()) {
    const prev = row.c.deepAudit as DeepAudit | null;
    if (prev?.version === DEEP_VERSION && row.c.deepAuditedAt && row.c.deepAuditedAt > auditFreshAfter && !search.brief) continue;
    if (ctx.llmDown) break;
    await setProgress(db, search.id, { stage: "Розбираю ролики й мовлення", done: i, total: toDeep.length }, stats);
    const adUrls = new Set(row.ads?.examples.map((e) => e.url) ?? []);
    const res = await withLlm(ctx, () => deepAudit(db, row.c.id, { posts: row.posts, adUrls, brief: search.brief }));
    if (res == null) break;
    if (res instanceof Error) {
      row.reasons.push(`розбір роликів не вдався: ${res.message.slice(0, 80)}`);
      continue;
    }
    if ("skipped" in res) continue;
    const lang = res.transcript?.language ?? null;
    const [u] = await db.update(creators)
      .set({ deepAudit: res as unknown as Record<string, unknown>, adQuality: adQualityIndex(res), deepAuditedAt: now, ...(lang ? { language: lang } : {}) })
      .where(eq(creators.id, row.c.id)).returning();
    if (u) row.c = u;
    stats.deepAudited++;
  }

  // 10. Реакція аудиторії: платна вибірка коментарів (за галочкою) + безкоштовні коментарі з дописів джерел.
  const toComments = alive.filter((r) => r.c.quality == null || r.c.quality >= ctx.criteria.quality.min).slice(0, Math.max(0, ctx.left.comments));
  ctx.left.comments -= toComments.length;
  stats.commentsAnalyzed ??= 0;
  for (const [i, row] of toComments.entries()) {
    if (row.c.commentsAt && now.getTime() - row.c.commentsAt.getTime() < COMMENTS_FRESH_MS) continue;
    const est = COMMENT_POSTS * COMMENTS_PER_POST * PRICE.comment;
    if (!canSpend(ctx, est)) {
      ctx.notes.push("Розбір коментарів зупинено: не вистачає бюджету");
      break;
    }
    await setProgress(db, search.id, { stage: "Читаю коментарі", done: i, total: toComments.length }, stats);
    const adUrls = new Set(row.ads?.examples.map((e) => e.url) ?? []);
    const picked = [...row.posts.filter((p) => adUrls.has(p.url)).slice(0, 1), ...row.posts.filter((p) => !adUrls.has(p.url) && !p.pinned)]
      .filter((p) => (p.comments ?? 1) > 0).slice(0, COMMENT_POSTS);
    if (!picked.length) continue;
    try {
      const r = await collect(db, { type: "instagram-comments", postUrls: picked.map((p) => p.url), perPost: COMMENTS_PER_POST });
      charge(ctx, r.costUsd, row.source);
      const shortOf = (u?: string) => u?.match(/\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/)?.[1];
      const urlByShort = new Map(picked.map((p) => [p.shortCode, p.url]));
      for (const item of r.items) {
        const postUrl = urlByShort.get(item.thread?.rootId ?? "") ?? item.url;
        row.comments.push({ text: item.text ?? "", owner: item.author?.username?.toLowerCase(), postUrl });
      }
      const seen = new Set<string>();
      row.comments = row.comments.filter((c) => {
        const k = `${shortOf(c.postUrl)}|${c.owner}|${c.text}`;
        return c.text && !seen.has(k) && (seen.add(k), true);
      });
    } catch (e) {
      row.reasons.push(`коментарі не зібрано: ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`);
    }
    await saveComments(ctx, row, adUrls);
  }
  // Автори без платної вибірки, але з безкоштовними коментарями з дописів — лише цифри, без моделі.
  for (const row of alive) {
    if (toComments.includes(row) || row.comments.length < 15 || row.c.commentsReport) continue;
    const m = commentMetrics(row.comments, row.c.username, row.c.language);
    const [u] = await db.update(creators).set({ commentsReport: { metrics: m, free: true } as unknown as Record<string, unknown> }).where(eq(creators.id, row.c.id)).returning();
    if (u) row.c = u;
  }

  // 11. Підсумок: довіра з урахуванням коментарів, критерії, пороги якості, «готові ліди».
  const finalRows = [];
  for (const row of rows) {
    if (row.reject.length) {
      finalRows.push({
        row, stage: "rejected" as const, readiness: null, quality: null, trust: row.trust?.score ?? null, match: null,
        reasons: [...row.reasons, ...trustReasons(row.trust), ...row.reject], lead: false,
      });
      continue;
    }
    const report = row.c.commentsReport as { metrics?: ReturnType<typeof commentMetrics>; analysis?: { botLike?: { value: string } } } | null;
    row.trust = await trustOf(ctx, row, report?.metrics ? { ...report.metrics, botLike: report.analysis?.botLike?.value === "yes" } : null);
    const audit = row.c.audit as Partial<VisionAudit> & { minor_is_main_subject?: boolean; brand_safety_flags?: string[] } | null;
    const quality = row.c.quality;
    const facts = factsOf(row, now, bestEmailOf(row));
    const crit = evaluateCriteria(ctx.criteria, search, facts);
    const reject = [...crit.reject];
    if (audit?.minor || audit?.minor_is_main_subject) reject.push("головні герої контенту — діти");
    const flags = audit?.flags ?? audit?.brand_safety_flags ?? [];
    if (flags.length) reject.push(`небезпечно для бренду: ${flags.join(", ")}`);
    if (quality != null && quality < ctx.criteria.quality.min) reject.push(`низька якість зйомки (${Math.round(quality)})`);
    const r = readinessOf(row);
    const ok = reject.length === 0;
    const reasons = [...row.reasons, ...r.reasons, ...(row.ads ? adsReasons(row.ads) : [])];
    reasons.push(...trustReasons(row.trust));
    if (row.c.adQuality != null) reasons.push(`рекламна подача ${Math.round(row.c.adQuality)}/100`);
    if (crit.preferredMet.length) reasons.push(`бажане виконано: ${crit.preferredMet.join(", ")}`);
    reasons.push(...crit.notes);
    if (row.c.reviewNote) reasons.push(row.c.reviewNote);
    const emailOk = ctx.criteria.email === "off" || facts.hasEmail === true;
    // TikTok: дати роликів і кадрів безкоштовно не дістати — лідом стає автор з email і без високого ризику,
    // а активність і якість зйомки ви перевіряєте самі, глянувши профіль.
    const tiktokLead = search.platform === "tiktok" && ok && emailOk && row.trust?.risk !== "high" && activityStatus(row.c.lastPostAt, now) !== "ghost";
    if (tiktokLead) reasons.push("TikTok: активність і якість зйомки не перевірено — гляньте профіль перед листом");
    const lead = tiktokLead || (ok && activityStatus(row.c.lastPostAt, now) === "active" && emailOk && quality != null && quality >= ctx.criteria.quality.lead && row.trust?.risk !== "high");
    if (ok) ctx.qualified.add(row.c.username);
    finalRows.push({ row, stage: ok ? ("qualified" as const) : ("rejected" as const), readiness: r.readiness, quality, trust: row.trust?.score ?? null, match: crit.match, reasons: [...reasons, ...reject], lead });
  }
  for (const f of finalRows) {
    const score = weightedScore(ctx.weights, { fit: f.row.fit, readiness: f.readiness, quality: f.quality, trust: f.trust, match: f.match });
    await db.update(searchCandidates)
      .set({ stage: f.stage, fit: f.row.fit, readiness: f.readiness, quality: f.quality, trust: f.trust, match: f.match, score, reasons: f.reasons, lead: f.lead })
      .where(and(eq(searchCandidates.searchId, search.id), eq(searchCandidates.creatorId, f.row.c.id)));
    if (f.stage === "qualified") sourceStats(ctx, f.row.source).qualified++;
    if (f.lead) sourceStats(ctx, f.row.source).leads++;
  }
  stats.qualified = (stats.qualified ?? 0) + finalRows.filter((f) => f.stage === "qualified").length;
  stats.leads = (stats.leads ?? 0) + finalRows.filter((f) => f.lead).length;
  stats.withEmail = (stats.withEmail ?? 0) + alive.filter((r) => r.c.emails.length > 0).length;
  stats.review = (stats.review ?? 0) + finalRows.filter((f) => f.stage === "qualified" && f.row.c.reviewNote).length;
}

const trustReasons = (t: TrustReport | null) =>
  t && t.risk !== "unknown" ? [...t.signals.filter((s) => s.level !== "info").map((s) => `мінус: ${s.text}`), ...(t.risk === "low" ? ["ризик накрутки: низький"] : [])] : [];

/** Записує профіль: поля, цифри дописів, знімок для історії. */
async function applyProfile(ctx: Ctx, c: Creator, raw: any, posts: PostFacts[]): Promise<Creator> {
  const { db, now } = ctx;
  const followers = typeof raw.followersCount === "number" && raw.followersCount >= 0 ? Math.round(raw.followersCount) : null;
  const m = postMetrics(posts, followers);
  // TikTok: роликів у відповіді немає, але є всі вподобання й кількість роликів — середнє за весь час.
  const likesTotal = typeof raw.likesTotal === "number" ? raw.likesTotal : null;
  const videoCount = typeof raw.postsCount === "number" ? raw.postsCount : null;
  if (m.erLikes == null && likesTotal != null && videoCount && followers) {
    m.erLikes = Math.round((likesTotal / videoCount / followers) * 10_000) / 10_000;
    m.lifetime = true;
  }
  const act = activityOf(posts.map((p) => ({ publishedAt: p.publishedAt ?? undefined, metrics: { views: p.views ?? undefined } })), followers, now);
  const links = [raw.externalUrl, ...(Array.isArray(raw.externalUrls) ? raw.externalUrls.map((l: any) => l?.url) : [])]
    .filter((l, i, a): l is string => typeof l === "string" && /^https?:\/\//.test(l) && a.indexOf(l) === i);
  const bio = typeof raw.biography === "string" && raw.biography ? raw.biography : null;
  const geo = detectCountry({ bio, links });
  const lang = detectLanguage([bio ?? "", ...posts.map((p) => p.caption)].join("\n"));
  const follows = typeof raw.followsCount === "number" && raw.followsCount >= 0 ? Math.round(raw.followsCount) : null;
  const [u] = await db.update(creators)
    .set({
      displayName: raw.fullName || null, bio, externalId: raw.id ? String(raw.id) : null, followers, follows,
      postsCount: typeof raw.postsCount === "number" ? raw.postsCount : null, links,
      avatarUrl: [raw.profilePicUrlHD, raw.profilePicUrl].find((x) => typeof x === "string" && /^https?:\/\//.test(x)) ?? null,
      verified: typeof raw.verified === "boolean" ? raw.verified : null,
      isPrivate: typeof raw.private === "boolean" ? raw.private : null,
      isBusiness: typeof raw.isBusinessAccount === "boolean" ? raw.isBusinessAccount : null,
      businessCategory: typeof raw.businessCategoryName === "string" ? raw.businessCategoryName : null,
      lastPostAt: act.lastPostAt, medianViews: act.medianViews, erViews: act.erViews, erLikes: m.erLikes,
      metrics: m as unknown as Record<string, unknown>,
      country: geo.country, countryConfidence: geo.country ? geo.confidence : null, language: lang.language,
      profileFetchedAt: now, updatedAt: now,
    })
    .where(eq(creators.id, c.id)).returning();
  await db.insert(creatorSnapshots).values({ creatorId: c.id, followers, follows, postsCount: typeof raw.postsCount === "number" ? raw.postsCount : null, erLikes: m.erLikes });
  return u ?? c;
}

/** Пам’ять відмов: причина зберігається в автора, і наступні пошуки не платять за його профіль. */
async function remember(ctx: Ctx, row: Row, reason: string) {
  row.reject.push(reason);
  await ctx.db.update(creators).set({ hardReject: reason, hardRejectAt: ctx.now }).where(eq(creators.id, row.c.id));
}

function factsOf(row: Row, now: Date, bestEmail?: string | null): CreatorFacts {
  const c = row.c;
  const deep = c.deepAudit as DeepAudit | null;
  return {
    followers: c.followers, country: c.country, language: c.language,
    daysSincePost: c.lastPostAt ? Math.floor((now.getTime() - c.lastPostAt.getTime()) / DAY) : null,
    erLikes: c.erLikes,
    hasEmail: bestEmail === undefined ? null : bestEmail === "personal" || bestEmail === "business",
    adPosts: row.ads ? row.ads.adPosts : null, postsSeen: row.ads?.posts ?? row.posts.length,
    trustRisk: row.trust?.risk ?? null,
    formats: deep?.formats ?? null,
  };
}

async function trustOf(ctx: Ctx, row: Row, comments: Parameters<typeof assessTrust>[0]["comments"]): Promise<TrustReport> {
  const snaps = await ctx.db.select().from(creatorSnapshots)
    .where(and(eq(creatorSnapshots.creatorId, row.c.id), gte(creatorSnapshots.at, new Date(ctx.now.getTime() - 120 * DAY))));
  const metrics = row.posts.length ? postMetrics(row.posts, row.c.followers) : (row.c.metrics as unknown as ReturnType<typeof postMetrics> | null);
  const report = assessTrust({
    followers: row.c.followers, follows: row.c.follows,
    metrics: metrics ?? postMetrics([], row.c.followers),
    norms: ctx.norms, snapshots: snaps.map((s): Snapshot => ({ at: s.at, followers: s.followers, erLikes: s.erLikes })), comments, now: ctx.now,
  });
  const [u] = await ctx.db.update(creators)
    .set({ trust: report as unknown as Record<string, unknown>, trustRisk: report.risk, ads: (row.ads ?? row.c.ads) as Record<string, unknown> | null })
    .where(eq(creators.id, row.c.id)).returning();
  if (u) row.c = u;
  return report;
}

async function secondOpinion(ctx: Ctx, collage: Buffer, frames: number, fromVideo: number, firstProvider: string) {
  try {
    return await scoreCollage(ctx.db, collage, frames, { fromVideo, examples: ctx.examples, exclude: [firstProvider] });
  } catch {
    return null; // іншої моделі немає або вона недоступна — тоді позначка «перегляньте вручну»
  }
}

async function saveComments(ctx: Ctx, row: Row, adUrls: Set<string>) {
  if (row.comments.length < 5) return;
  const metrics = commentMetrics(row.comments, row.c.username, row.c.language);
  const analysis = await withLlm(ctx, () => analyzeComments(ctx.db, row.comments.map((c) => ({ ...c, ad: !!c.postUrl && adUrls.has(c.postUrl) })), row.c.username));
  const report = { metrics, analysis: analysis && !(analysis instanceof Error) ? analysis : null, free: false };
  const [u] = await ctx.db.update(creators)
    .set({ commentsReport: report as unknown as Record<string, unknown>, commentsAt: ctx.now }).where(eq(creators.id, row.c.id)).returning();
  if (u) row.c = u;
  ctx.stats.commentsAnalyzed = (ctx.stats.commentsAnalyzed ?? 0) + 1;
  if (report.analysis?.purchaseIntent.value === "yes") row.reasons.push("у коментарях питають, де купити");
  if (report.analysis?.trustsCreator.value === "yes") row.reasons.push("аудиторія купує за порадою автора");
}

/** Бере наступний пошук із черги й виконує його. Повертає false, якщо черга порожня. */
export async function runNextSearch(db: Db): Promise<boolean> {
  await scheduleRepeats(db);
  const [next] = await db
    .update(searches)
    .set({ status: "running", startedAt: new Date(), error: null })
    .where(eq(searches.id, sql`(select id from searches where status = 'queued' order by created_at limit 1 for update skip locked)`))
    .returning({ id: searches.id });
  if (!next) return false;
  await runSearch(db, next.id);
  return true;
}

/**
 * Повтор за розкладом: коли минуло repeatDays від завершення останнього запуску серії, створюється
 * новий пошук з тими самими налаштуваннями — він покаже лише авторів, яких серія ще не бачила.
 */
export async function scheduleRepeats(db: Db, now = new Date()): Promise<number> {
  const rows = await db.select().from(searches).where(and(isNotNull(searches.repeatDays), eq(searches.status, "done")));
  let created = 0;
  for (const s of rows) {
    const root = s.parentId ?? s.id;
    const [later] = await db.select({ id: searches.id }).from(searches)
      .where(and(eq(searches.parentId, root), sql`${searches.id} > ${s.id}`)).limit(1);
    if (later || !s.finishedAt || now.getTime() - s.finishedAt.getTime() < s.repeatDays! * DAY) continue;
    const { id: _id, createdAt: _c, startedAt: _s, finishedAt: _f, status: _st, progress: _p, stats: _x, error: _e, ...config } = s;
    await db.insert(searches).values({ ...config, parentId: root, name: `${s.name.replace(/ · повтор.*$/, "")} · повтор ${new Intl.DateTimeFormat("uk-UA", { day: "2-digit", month: "2-digit" }).format(now)}` });
    created++;
  }
  return created;
}

/** Після перезапуску сервера перервані пошуки повертаються в чергу: зібране вже в кеші. */
export async function requeueInterrupted(db: Db): Promise<void> {
  await db.update(searches).set({ status: "queued", progress: null }).where(eq(searches.status, "running"));
}

const g = globalThis as unknown as { __searchWorker?: boolean };

/** Фоновий виконавець у процесі сервера: по одному завданню за раз; extra — інші черги (пакетний збір). */
export function startSearchWorker(getDb: () => Db, extra: ((db: Db) => Promise<boolean>)[] = []): void {
  if (g.__searchWorker) return;
  g.__searchWorker = true;
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const queues = [runNextSearch, ...extra];
      for (let worked = true; worked; ) {
        worked = false;
        for (const next of queues) if (await next(getDb())) worked = true;
      }
    } catch (e) {
      console.error("Помилка виконавця пошуків:", e);
    } finally {
      busy = false;
    }
  }, 3000).unref();
}
