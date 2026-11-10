import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { auditCreator, type VisionAudit } from "@/audit/vision";
import { collect, collectProfiles } from "@/collect";
import { getPageHtml } from "@/collect/html";
import type { ContentItem } from "@/core/contract";
import type { Db } from "@/db/client";
import {
  contentItems, creatorContacts, creators, searchCandidates, searches,
  type Creator, type CreatorRate, type Search, type SearchProgress, type SearchStats,
} from "@/db/schema";
import { activityOf, activityStatus } from "@/enrich/activity";
import { checkEmail, usable, type EmailCheck } from "@/enrich/email";
import { extractLinkPage } from "@/enrich/linkpage";
import { classifyLinks } from "@/enrich/links";
import { LlmUnavailableError } from "@/llm/client";
import { extractEmails, overall, readinessIndex, scoreCandidate } from "./signals";
import { emailKey, suppressedSet, usernameKey } from "./suppress";

/** Приблизна ціна одного результату актора Apify, $. */
export const PRICE_PER_RESULT_USD = 0.0026;
const DAY = 86_400_000;
/** Профіль і сторінки-візитки, зібрані не давніше цього, повторно не запитуємо. */
const PROFILE_FRESH_MS = 7 * DAY;
const LINKS_FRESH_MS = 7 * DAY;
const AUDIT_FRESH_MS = 30 * DAY;
const PROFILE_CHUNK = 50;
/** Пороги якості: нижче MIN — відхиляємо, від LEAD — «готовий лід». */
export const QUALITY_MIN = 40;
export const QUALITY_LEAD = 70;

export const estimateCostUsd = (s: Pick<Search, "hashtags" | "postsPerTag" | "maxProfiles">) =>
  Math.round((s.hashtags.length * s.postsPerTag + s.maxProfiles) * PRICE_PER_RESULT_USD * 100) / 100;

class Cancelled extends Error {}

async function setProgress(db: Db, id: number, progress: SearchProgress, stats?: SearchStats) {
  const [row] = await db.update(searches).set({ progress, ...(stats ? { stats } : {}) }).where(eq(searches.id, id)).returning({ status: searches.status });
  if (row?.status === "cancelled") throw new Cancelled();
}

const postText = (p: ContentItem) => [p.text ?? "", p.tags.map((t) => `#${t}`).join(" ")].join("\n");
const coverOf = (p: ContentItem) => p.media[0]?.thumbnailUrl ?? (p.media[0]?.type === "image" ? p.media[0].url : undefined);
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

/** Сторінки-візитки автора: до двох посилань, спершу відомі сервіси, потім власні сайти. */
function pagesToVisit(c: Creator): string[] {
  const { hubs } = classifyLinks(c.links);
  const others = c.links.filter((l) => !hubs.includes(l) && !/(instagram|tiktok|youtube|facebook|amazon|amzn|shopltk|liketk|shopmy|spotify|apple|google|whatsapp|t\.me|x\.com|twitter)\./i.test(l));
  return [...hubs, ...others].slice(0, 2);
}

type Enrichment = { emails: { email: string; source: string; sourceUrl: string }[]; rates: CreatorRate[]; portfolio: string[]; affiliate: string[]; socials: Record<string, string>; pages: number };

/** Безкоштовне збагачення: біо + посилання профілю + сторінки-візитки. */
async function enrich(c: Creator): Promise<Enrichment> {
  const profileUrl = `https://www.instagram.com/${c.username}/`;
  const fromProfile = classifyLinks(c.links);
  const out: Enrichment = {
    emails: extractEmails(c.bio).map((email) => ({ email, source: "bio", sourceUrl: profileUrl })),
    rates: [], portfolio: [...fromProfile.portfolio], affiliate: [...fromProfile.affiliate], socials: { ...fromProfile.socials }, pages: 0,
  };
  for (const url of pagesToVisit(c)) {
    let page;
    try {
      page = await getPageHtml(url);
    } catch {
      continue; // внутрішня адреса чи некоректне посилання
    }
    if ("error" in page) continue;
    out.pages++;
    const data = extractLinkPage(page.html, url);
    for (const e of data.emails) if (!out.emails.some((x) => x.email === e.email)) out.emails.push({ email: e.email, source: "link_page", sourceUrl: url });
    for (const o of data.offers) if (o.ugcRate) out.rates.push({ title: o.title, amount: o.amount, currency: o.currency, sourceUrl: url });
    out.portfolio.push(...data.portfolio);
    out.affiliate.push(...data.affiliate);
    out.socials = { ...data.socials, ...out.socials };
  }
  out.portfolio = [...new Set(out.portfolio)].slice(0, 5);
  out.affiliate = [...new Set(out.affiliate)];
  out.rates = out.rates.slice(0, 10);
  return out;
}

const EMAIL_RANK: Record<string, number> = { personal: 4, business: 3, unknown: 2, role: 1 };

/**
 * Воронка: хештеги → безкоштовний відбір за текстом → профілі найкращих одним запуском →
 * активність → сторінки-візитки й перевірка email → три індекси → візуальний аудит найкращих.
 * Кроки ідемпотентні (збір і збагачення кешуються), тому перерваний пошук можна просто запустити знову.
 */
export async function runSearch(db: Db, searchId: number): Promise<void> {
  const [search] = await db.select().from(searches).where(eq(searches.id, searchId));
  if (!search) return;
  const stats: SearchStats = {};
  const scoreArgs = { keywords: search.keywords, stopWords: search.stopWords, ignoreTags: search.hashtags, focus: search.focus };
  try {
    // 1. Дописи за хештегами.
    const posts = new Map<string, { item: ContentItem; id: number }>();
    for (const [i, tag] of search.hashtags.entries()) {
      await setProgress(db, searchId, { stage: `Збираю дописи #${tag}`, done: i, total: search.hashtags.length });
      const r = await collect(db, { type: "instagram-hashtag", tag, limit: search.postsPerTag });
      r.items.forEach((item, n) => posts.set(item.id, { item, id: r.ids[n] }));
    }
    stats.posts = posts.size;

    // 2. Групуємо за автором; авторів зі списку виключень не чіпаємо взагалі.
    const byAuthor = new Map<string, { displayName?: string; externalId?: string; posts: { item: ContentItem; id: number }[] }>();
    for (const p of posts.values()) {
      const username = p.item.author?.username?.toLowerCase();
      if (!username) continue;
      const entry = byAuthor.get(username) ?? { posts: [] };
      entry.displayName ??= p.item.author?.displayName;
      entry.externalId ??= p.item.author?.id;
      entry.posts.push(p);
      byAuthor.set(username, entry);
    }
    const suppressed = await suppressedSet(db, [...byAuthor.keys()].map((u) => usernameKey(search.platform, u)));
    for (const u of [...byAuthor.keys()]) if (suppressed.has(usernameKey(search.platform, u))) byAuthor.delete(u);
    stats.authors = byAuthor.size;
    await setProgress(db, searchId, { stage: "Відбираю авторів за текстом", done: 0, total: byAuthor.size }, stats);
    if (byAuthor.size === 0) {
      await db.update(searches).set({ status: "done", stats, finishedAt: new Date(), progress: null }).where(eq(searches.id, searchId));
      return;
    }

    const names = [...byAuthor.keys()];
    for (let i = 0; i < names.length; i += 200) {
      await db.insert(creators)
        .values(names.slice(i, i + 200).map((username) => ({
          platform: search.platform, username,
          displayName: byAuthor.get(username)!.displayName ?? null, externalId: byAuthor.get(username)!.externalId ?? null,
        })))
        .onConflictDoNothing({ target: [creators.platform, creators.username] });
    }
    const loadCreators = async (usernames: string[]) =>
      usernames.length ? db.select().from(creators).where(and(eq(creators.platform, search.platform), inArray(creators.username, usernames))) : [];
    const creatorBy = new Map((await loadCreators(names)).map((c) => [c.username, c]));
    const textsOf = (username: string) => byAuthor.get(username)!.posts.map((p) => postText(p.item));

    // 3. Безкоштовний відбір за підписами (і біо, якщо профіль уже є).
    const scored = names.map((username) => {
      const c = creatorBy.get(username)!;
      const s = scoreCandidate({ ...scoreArgs, texts: textsOf(username), bio: c.bio, affiliate: c.affiliate });
      return { username, creator: c, postIds: byAuthor.get(username)!.posts.map((p) => p.id), ...s };
    });
    scored.sort((a, b) => b.fit - a.fit || b.postIds.length - a.postIds.length || a.username.localeCompare(b.username));
    // Магазини, агенції та стоп-слова відсіюємо одразу. Автори без текстових сигналів ідуть у кінець
    // черги: сам хештег пошуку — слабка ознака, тож профіль їм беремо, лише якщо лишилося місце в ліміті.
    const shortlist = scored.filter((s) => !s.blocked && !s.negative).slice(0, search.maxProfiles);
    const shortSet = new Set(shortlist.map((s) => s.username));
    stats.shortlisted = shortlist.length;

    for (let i = 0; i < scored.length; i += 200) {
      await db.insert(searchCandidates)
        .values(scored.slice(i, i + 200).map((s) => ({
          searchId, creatorId: s.creator.id, postIds: s.postIds, fit: s.fit, score: s.fit,
          stage: shortSet.has(s.username) ? ("shortlisted" as const) : ("filtered_out" as const),
          reasons: shortSet.has(s.username)
            ? s.reasons
            : [...s.reasons, s.blocked ? "відсіяно стоп-словом" : s.negative ? "відсіяно за текстом дописів" : "не увійшов до ліміту профілів"],
        })))
        .onConflictDoUpdate({
          target: [searchCandidates.searchId, searchCandidates.creatorId],
          set: {
            postIds: sql`excluded.post_ids`, fit: sql`excluded.fit`, readiness: sql`null`, quality: sql`null`, lead: sql`false`,
            score: sql`excluded.score`, stage: sql`excluded.stage`, reasons: sql`excluded.reasons`,
          },
        });
    }

    // 4. Профілі — лише для відібраних і лише тих, кого давно не збирали. Заодно рахуємо активність.
    const now = new Date();
    const freshAfter = new Date(now.getTime() - PROFILE_FRESH_MS);
    const need = shortlist.filter((s) => !s.creator.profileFetchedAt || s.creator.profileFetchedAt < freshAfter).map((s) => s.username);
    stats.profilesReused = shortlist.length - need.length;
    stats.profilesFetched = 0;
    /** Свіжі обкладинки дописів: посилання Instagram живуть недовго, тому аудит робимо в цьому ж проході. */
    const covers = new Map<string, string[]>();
    for (let i = 0; i < need.length; i += PROFILE_CHUNK) {
      await setProgress(db, searchId, { stage: "Збираю профілі відібраних авторів", done: i, total: need.length }, stats);
      const chunk = need.slice(i, i + PROFILE_CHUNK);
      const { batch } = await collectProfiles(db, chunk);
      const items = batch.collected.map((c) => c.item as ContentItem);
      const seen = new Set<string>();
      for (const { item, raw } of batch.collected) {
        if (item.kind !== "profile" || !item.author?.username) continue;
        const username = item.author.username.toLowerCase();
        seen.add(username);
        const r = (raw ?? {}) as Record<string, unknown>;
        // Дописи самого автора (спільні дописи з чужих акаунтів не рахуємо).
        const own = items.filter((p) => p.kind !== "profile" && p.author?.username?.toLowerCase() === username);
        const act = activityOf(own.map((p) => ({ publishedAt: p.publishedAt ? new Date(p.publishedAt) : undefined, metrics: p.metrics ?? {} })), item.author.followers);
        covers.set(username, own.map((p) => coverOf(p)).filter((u): u is string => !!u));
        await db.update(creators)
          .set({
            displayName: item.author.displayName ?? null, bio: item.author.bio ?? null, externalId: item.author.id ?? null,
            followers: item.author.followers != null ? Math.round(item.author.followers) : null,
            postsCount: typeof r.postsCount === "number" ? r.postsCount : null,
            links: item.author.links ?? [], avatarUrl: item.author.avatarUrl ?? null, verified: item.author.verified ?? null,
            isPrivate: typeof r.private === "boolean" ? r.private : null,
            isBusiness: typeof r.isBusinessAccount === "boolean" ? r.isBusinessAccount : null,
            lastPostAt: act.lastPostAt, medianViews: act.medianViews, erViews: act.erViews,
            profileFetchedAt: now, updatedAt: now,
          })
          .where(and(eq(creators.platform, search.platform), eq(creators.username, username)));
        stats.profilesFetched++;
      }
      // Профіль не повернувся (видалений, перейменований): позначаємо, щоб не питати щоразу.
      const missing = chunk.filter((u) => !seen.has(u));
      if (missing.length) {
        await db.update(creators).set({ profileFetchedAt: now, updatedAt: now })
          .where(and(eq(creators.platform, search.platform), inArray(creators.username, missing), sql`${creators.followers} is null`));
      }
    }

    // 5. Жорсткі фільтри після профілю — до витрат на збагачення й аудит.
    type Row = { c: Creator; fit: number; reasons: string[]; reject: string[] };
    const rows: Row[] = [];
    for (const c of await loadCreators(shortlist.map((s) => s.username))) {
      const s = scoreCandidate({ ...scoreArgs, texts: textsOf(c.username), bio: c.bio, affiliate: c.affiliate });
      const reject: string[] = [];
      if (c.followers == null && c.bio == null) reject.push("профіль не знайдено");
      if (c.isPrivate) reject.push("закритий профіль");
      if (search.minFollowers != null && c.followers != null && c.followers < search.minFollowers) reject.push(`замало підписників (${c.followers})`);
      if (search.maxFollowers != null && c.followers != null && c.followers > search.maxFollowers) reject.push(`забагато підписників (${c.followers})`);
      if (s.blocked) reject.push("відсіяно стоп-словом");
      if (s.negative) reject.push("не окремий автор (магазин, агенція чи платформа)");
      if (activityStatus(c.lastPostAt, now) === "ghost") reject.push("не публікує понад 30 днів");
      rows.push({ c, fit: s.fit, reasons: s.reasons, reject });
    }
    const alive = rows.filter((r) => r.reject.length === 0);

    // 6. Сторінки-візитки та перевірка email (безкоштовно).
    stats.linkPages = 0;
    let done = 0;
    const linksFreshAfter = new Date(now.getTime() - LINKS_FRESH_MS);
    await mapLimit(alive, 3, async (row) => {
      if (!row.c.linksCheckedAt || row.c.linksCheckedAt < linksFreshAfter || row.c.linksCheckedAt < (row.c.profileFetchedAt ?? row.c.linksCheckedAt)) {
        const e = await enrich(row.c);
        stats.linkPages! += e.pages;
        const blockedEmails = await suppressedSet(db, e.emails.map((x) => emailKey(x.email)));
        const checks: (EmailCheck & { source: string; sourceUrl: string })[] = [];
        for (const found of e.emails.filter((x) => !blockedEmails.has(emailKey(x.email))).slice(0, 5)) {
          checks.push({ ...(await checkEmail(found.email)), source: found.source, sourceUrl: found.sourceUrl });
        }
        if (checks.length) {
          await db.insert(creatorContacts)
            .values(checks.map((k) => ({ creatorId: row.c.id, email: k.email, status: k.status, confidence: k.confidence, mx: k.mx, source: k.source, sourceUrl: k.sourceUrl })))
            .onConflictDoUpdate({
              target: [creatorContacts.creatorId, creatorContacts.email],
              set: { status: sql`excluded.status`, confidence: sql`excluded.confidence`, mx: sql`excluded.mx`, checkedAt: new Date() },
            });
        }
        const good = checks.filter(usable).sort((a, b) => b.confidence - a.confidence).map((k) => k.email);
        const [updated] = await db.update(creators)
          .set({ emails: good, rates: e.rates, portfolio: e.portfolio, affiliate: e.affiliate, socials: e.socials, linksCheckedAt: new Date(), updatedAt: new Date() })
          .where(eq(creators.id, row.c.id)).returning();
        if (updated) row.c = updated;
      }
      if (++done % 5 === 0 || done === alive.length) {
        await setProgress(db, searchId, { stage: "Шукаю контакти на сторінках-візитках", done, total: alive.length }, stats);
      }
    });

    // 7. Fit і Readiness з урахуванням знайденого.
    const contactRows = alive.length
      ? await db.select().from(creatorContacts).where(inArray(creatorContacts.creatorId, alive.map((r) => r.c.id)))
      : [];
    type Ranked = Row & { readiness: number; bestEmail: string | null };
    const ranked: Ranked[] = alive.map((row) => {
      const s = scoreCandidate({ ...scoreArgs, texts: textsOf(row.c.username), bio: row.c.bio, affiliate: row.c.affiliate });
      const best = contactRows.filter((k) => k.creatorId === row.c.id && row.c.emails.includes(k.email))
        .sort((a, b) => (EMAIL_RANK[b.status] ?? 0) - (EMAIL_RANK[a.status] ?? 0))[0];
      const days = row.c.lastPostAt ? Math.floor((now.getTime() - row.c.lastPostAt.getTime()) / DAY) : null;
      const r = readinessIndex({
        emailStatus: best?.status, daysSincePost: days, hasRate: row.c.rates.length > 0,
        hasPortfolio: row.c.portfolio.length > 0 || classifyLinks(row.c.links).hubs.length > 0,
      });
      return { ...row, fit: s.fit, reasons: [...s.reasons, ...r.reasons], readiness: r.readiness, bestEmail: best?.status ?? null };
    });
    stats.withEmail = ranked.filter((r) => r.c.emails.length > 0).length;
    ranked.sort((a, b) => overall(b.fit, b.readiness) - overall(a.fit, a.readiness));

    // 8. Візуальний аудит найкращих (Quality). Витрачає ліміт мовної моделі, тому обмежений.
    stats.audited = 0;
    const auditFreshAfter = new Date(now.getTime() - AUDIT_FRESH_MS);
    const toAudit = ranked.slice(0, search.auditLimit);
    let llmDown: string | null = null;
    for (const [i, row] of toAudit.entries()) {
      if (row.c.auditedAt && row.c.auditedAt > auditFreshAfter && row.c.quality != null) continue;
      if (llmDown) break;
      await setProgress(db, searchId, { stage: "Оцінюю якість візуалу", done: i, total: toAudit.length }, stats);
      let urls = covers.get(row.c.username) ?? [];
      if (urls.length === 0) {
        const stored = await db.select({ data: contentItems.data }).from(contentItems)
          .where(and(eq(contentItems.source, search.platform), eq(contentItems.authorUsername, row.c.username)))
          .orderBy(desc(contentItems.fetchedAt)).limit(12);
        urls = stored.map((r) => coverOf(r.data)).filter((u): u is string => !!u);
      }
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await auditCreator(db, row.c.id, urls);
          if ("skipped" in result) row.reasons.push(`аудит пропущено: ${result.skipped}`);
          else {
            const [updated] = await db.update(creators)
              .set({ quality: result.quality, audit: result.audit, auditedAt: new Date() }).where(eq(creators.id, row.c.id)).returning();
            if (updated) row.c = updated;
            stats.audited++;
          }
          break;
        } catch (e) {
          // Вичерпано хвилинний ліміт моделі — коротка пауза; надовго — зупиняємо аудит, решта лишиться без Quality.
          if (e instanceof LlmUnavailableError && e.retryAt && e.retryAt.getTime() - Date.now() < 90_000 && attempt < 3) {
            await sleep(Math.max(1000, e.retryAt.getTime() - Date.now() + 500));
            continue;
          }
          if (e instanceof LlmUnavailableError) llmDown = e.message;
          else row.reasons.push(`аудит не вдався: ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`);
          break;
        }
      }
    }
    if (llmDown) stats.note = `Візуальний аудит зупинено: ${llmDown.slice(0, 200)}. Запустіть пошук знову пізніше — оцінені автори не перераховуються.`;

    // 9. Підсумок: відхилення за аудитом, загальна оцінка, «готові ліди».
    let qualified = 0;
    let leads = 0;
    const finalRows = [
      ...ranked.map((row) => {
        const audit = row.c.audit as VisionAudit | null;
        const quality = row.c.quality;
        const reject: string[] = [];
        if (audit?.minor_is_main_subject) reject.push("головні герої контенту — діти");
        if (audit && (audit.brand_safety_flags.length > 0 || audit.rejection_reasons.includes("BRAND_UNSAFE"))) reject.push(`небезпечно для бренду: ${audit.brand_safety_flags.join(", ") || "позначено моделлю"}`);
        if (quality != null && quality < QUALITY_MIN) reject.push(`низька якість зйомки (${Math.round(quality)})`);
        const ok = reject.length === 0;
        const active = activityStatus(row.c.lastPostAt, now) === "active";
        const lead = ok && active && (row.bestEmail === "personal" || row.bestEmail === "business") && quality != null && quality >= QUALITY_LEAD;
        if (ok) qualified++;
        if (lead) leads++;
        return { row, stage: ok ? ("qualified" as const) : ("rejected" as const), quality, readiness: row.readiness as number | null, reasons: [...row.reasons, ...reject], lead };
      }),
      ...rows.filter((r) => r.reject.length > 0).map((row) => ({ row, stage: "rejected" as const, quality: null, readiness: null, reasons: [...row.reasons, ...row.reject], lead: false })),
    ];
    for (const f of finalRows) {
      await db.update(searchCandidates)
        .set({ stage: f.stage, fit: f.row.fit, readiness: f.readiness, quality: f.quality, score: overall(f.row.fit, f.readiness, f.quality), reasons: f.reasons, lead: f.lead })
        .where(and(eq(searchCandidates.searchId, searchId), eq(searchCandidates.creatorId, f.row.c.id)));
    }
    stats.qualified = qualified;
    stats.leads = leads;
    await db.update(searches).set({ status: "done", stats, finishedAt: new Date(), progress: null, error: null }).where(eq(searches.id, searchId));
  } catch (e) {
    if (e instanceof Cancelled) {
      await db.update(searches).set({ finishedAt: new Date(), progress: null, stats }).where(eq(searches.id, searchId));
      return;
    }
    await db.update(searches)
      .set({ status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 2000), finishedAt: new Date(), progress: null, stats })
      .where(eq(searches.id, searchId));
  }
}

/** Бере наступний пошук із черги й виконує його. Повертає false, якщо черга порожня. */
export async function runNextSearch(db: Db): Promise<boolean> {
  const [next] = await db
    .update(searches)
    .set({ status: "running", startedAt: new Date(), error: null })
    .where(eq(searches.id, sql`(select id from searches where status = 'queued' order by created_at limit 1 for update skip locked)`))
    .returning({ id: searches.id });
  if (!next) return false;
  await runSearch(db, next.id);
  return true;
}

/** Після перезапуску сервера перервані пошуки повертаються в чергу: зібране вже в кеші. */
export async function requeueInterrupted(db: Db): Promise<void> {
  await db.update(searches).set({ status: "queued", progress: null }).where(eq(searches.status, "running"));
}

const g = globalThis as unknown as { __searchWorker?: boolean };

/** Фоновий виконавець у процесі сервера: один пошук за раз. */
export function startSearchWorker(getDb: () => Db): void {
  if (g.__searchWorker) return;
  g.__searchWorker = true;
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      while (await runNextSearch(getDb()));
    } catch (e) {
      console.error("Помилка виконавця пошуків:", e);
    } finally {
      busy = false;
    }
  }, 3000).unref();
}
