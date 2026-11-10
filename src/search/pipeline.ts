import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { collect, collectProfiles } from "@/collect";
import type { ContentItem } from "@/core/contract";
import type { Db } from "@/db/client";
import { creators, searchCandidates, searches, type Search, type SearchProgress, type SearchStats } from "@/db/schema";
import { extractEmails, scoreCandidate } from "./signals";

/** Приблизна ціна одного результату актора Apify, $. */
export const PRICE_PER_RESULT_USD = 0.0026;
/** Профіль, зібраний не давніше цього, повторно не запитуємо. */
const PROFILE_FRESH_MS = 7 * 24 * 3600_000;
const PROFILE_CHUNK = 50;

export const estimateCostUsd = (s: Pick<Search, "hashtags" | "postsPerTag" | "maxProfiles">) =>
  Math.round((s.hashtags.length * s.postsPerTag + s.maxProfiles) * PRICE_PER_RESULT_USD * 100) / 100;

class Cancelled extends Error {}

async function setProgress(db: Db, id: number, progress: SearchProgress, stats?: SearchStats) {
  const [row] = await db
    .update(searches)
    .set({ progress, ...(stats ? { stats } : {}) })
    .where(eq(searches.id, id))
    .returning({ status: searches.status });
  if (row?.status === "cancelled") throw new Cancelled();
}

const postText = (p: ContentItem) => [p.text ?? "", p.tags.map((t) => `#${t}`).join(" ")].join("\n");

/**
 * Воронка пошуку: хештеги → безкоштовний текстовий відбір → профілі найкращих одним запуском → оцінка.
 * Кроки ідемпотентні (збір кешується), тому перерваний пошук можна просто запустити знову.
 */
export async function runSearch(db: Db, searchId: number): Promise<void> {
  const [search] = await db.select().from(searches).where(eq(searches.id, searchId));
  if (!search) return;
  const stats: SearchStats = {};
  try {
    // 1. Дописи за хештегами.
    const posts = new Map<string, { item: ContentItem; id: number }>();
    for (const [i, tag] of search.hashtags.entries()) {
      await setProgress(db, searchId, { stage: `Збираю дописи #${tag}`, done: i, total: search.hashtags.length });
      const r = await collect(db, { type: "instagram-hashtag", tag, limit: search.postsPerTag });
      r.items.forEach((item, n) => posts.set(item.id, { item, id: r.ids[n] }));
    }
    stats.posts = posts.size;

    // 2. Групуємо за автором і записуємо креаторів.
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
    stats.authors = byAuthor.size;
    await setProgress(db, searchId, { stage: "Відбираю авторів за текстом", done: 0, total: byAuthor.size }, stats);
    if (byAuthor.size === 0) {
      await db.update(searches).set({ status: "done", stats, finishedAt: new Date(), progress: null }).where(eq(searches.id, searchId));
      return;
    }

    const names = [...byAuthor.keys()];
    for (let i = 0; i < names.length; i += 200) {
      await db
        .insert(creators)
        .values(names.slice(i, i + 200).map((username) => ({
          platform: search.platform, username,
          displayName: byAuthor.get(username)!.displayName ?? null, externalId: byAuthor.get(username)!.externalId ?? null,
        })))
        .onConflictDoNothing({ target: [creators.platform, creators.username] });
    }
    const known = await db.select().from(creators).where(and(eq(creators.platform, search.platform), inArray(creators.username, names)));
    const creatorBy = new Map(known.map((c) => [c.username, c]));

    // 3. Безкоштовний відбір: оцінюємо за підписами (і біо, якщо профіль уже є), беремо найкращих.
    const scored = names.map((username) => {
      const c = creatorBy.get(username)!;
      const entry = byAuthor.get(username)!;
      const s = scoreCandidate({
        texts: entry.posts.map((p) => postText(p.item)), bio: c.bio, links: c.links,
        keywords: search.keywords, stopWords: search.stopWords, ignoreTags: search.hashtags,
      });
      return { username, creator: c, postIds: entry.posts.map((p) => p.id), ...s };
    });
    scored.sort((a, b) => b.score - a.score || b.postIds.length - a.postIds.length || a.username.localeCompare(b.username));
    // Магазини, агенції та стоп-слова відсіюємо одразу. Автори без текстових сигналів ідуть у кінець
    // черги: сам хештег пошуку — слабка ознака, тож профіль їм беремо, лише якщо лишилося місце в ліміті.
    const shortlist = scored.filter((s) => !s.blocked && !s.negative).slice(0, search.maxProfiles);
    const shortSet = new Set(shortlist.map((s) => s.username));
    stats.shortlisted = shortlist.length;

    for (let i = 0; i < scored.length; i += 200) {
      await db
        .insert(searchCandidates)
        .values(scored.slice(i, i + 200).map((s) => ({
          searchId, creatorId: s.creator.id, postIds: s.postIds, fit: s.fit, readiness: s.readiness, score: s.score,
          stage: shortSet.has(s.username) ? ("shortlisted" as const) : ("filtered_out" as const),
          reasons: shortSet.has(s.username)
            ? s.reasons
            : [...s.reasons, s.blocked ? "відсіяно стоп-словом" : s.negative ? "відсіяно за текстом дописів" : "не увійшов до ліміту профілів"],
        })))
        .onConflictDoUpdate({
          target: [searchCandidates.searchId, searchCandidates.creatorId],
          set: {
            postIds: sql`excluded.post_ids`, fit: sql`excluded.fit`, readiness: sql`excluded.readiness`,
            score: sql`excluded.score`, stage: sql`excluded.stage`, reasons: sql`excluded.reasons`,
          },
        });
    }

    // 4. Профілі — лише для відібраних і лише тих, кого давно не збирали.
    const freshAfter = new Date(Date.now() - PROFILE_FRESH_MS);
    const need = shortlist.filter((s) => !s.creator.profileFetchedAt || s.creator.profileFetchedAt < freshAfter).map((s) => s.username);
    stats.profilesReused = shortlist.length - need.length;
    stats.profilesFetched = 0;
    for (let i = 0; i < need.length; i += PROFILE_CHUNK) {
      await setProgress(db, searchId, { stage: "Збираю профілі відібраних авторів", done: i, total: need.length }, stats);
      const chunk = need.slice(i, i + PROFILE_CHUNK);
      const { batch } = await collectProfiles(db, chunk);
      const now = new Date();
      const seen = new Set<string>();
      for (const { item, raw } of batch.collected) {
        if (item.kind !== "profile" || !item.author?.username) continue;
        const username = item.author.username.toLowerCase();
        seen.add(username);
        const r = (raw ?? {}) as Record<string, unknown>;
        await db
          .update(creators)
          .set({
            displayName: item.author.displayName ?? null, bio: item.author.bio ?? null, externalId: item.author.id ?? null,
            followers: item.author.followers != null ? Math.round(item.author.followers) : null,
            postsCount: typeof r.postsCount === "number" ? r.postsCount : null,
            links: item.author.links ?? [], emails: extractEmails(item.author.bio),
            avatarUrl: item.author.avatarUrl ?? null, verified: item.author.verified ?? null,
            isPrivate: typeof r.private === "boolean" ? r.private : null,
            isBusiness: typeof r.isBusinessAccount === "boolean" ? r.isBusinessAccount : null,
            profileFetchedAt: now, updatedAt: now,
          })
          .where(and(eq(creators.platform, search.platform), eq(creators.username, username)));
        stats.profilesFetched++;
      }
      // Профіль не повернувся (видалений, перейменований): позначаємо, щоб не питати щоразу.
      const missing = chunk.filter((u) => !seen.has(u));
      if (missing.length) {
        await db.update(creators).set({ profileFetchedAt: now, updatedAt: now, isPrivate: null })
          .where(and(eq(creators.platform, search.platform), inArray(creators.username, missing), sql`${creators.followers} is null`));
      }
    }

    // 5. Остаточна оцінка з урахуванням біо, посилань і розміру аудиторії.
    await setProgress(db, searchId, { stage: "Оцінюю кандидатів", done: 0, total: shortlist.length }, stats);
    const fresh = await db.select().from(creators)
      .where(and(eq(creators.platform, search.platform), inArray(creators.username, shortlist.length ? shortlist.map((s) => s.username) : [""])));
    const freshBy = new Map(fresh.map((c) => [c.username, c]));
    let qualified = 0;
    for (const s of shortlist) {
      const c = freshBy.get(s.username)!;
      const entry = byAuthor.get(s.username)!;
      const final = scoreCandidate({
        texts: entry.posts.map((p) => postText(p.item)), bio: c.bio, links: c.links,
        keywords: search.keywords, stopWords: search.stopWords, ignoreTags: search.hashtags,
      });
      const reject: string[] = [];
      if (c.followers == null && c.bio == null) reject.push("профіль не знайдено");
      if (c.isPrivate) reject.push("закритий профіль");
      if (search.minFollowers != null && c.followers != null && c.followers < search.minFollowers) reject.push(`замало підписників (${c.followers})`);
      if (search.maxFollowers != null && c.followers != null && c.followers > search.maxFollowers) reject.push(`забагато підписників (${c.followers})`);
      if (final.blocked) reject.push("відсіяно стоп-словом");
      if (final.negative) reject.push("не окремий автор (магазин, агенція чи платформа)");
      if (final.readiness === 0) reject.push("немає ознак готовності до співпраці");
      const ok = reject.length === 0;
      if (ok) qualified++;
      await db
        .update(searchCandidates)
        .set({ stage: ok ? "qualified" : "rejected", fit: final.fit, readiness: final.readiness, score: final.score, reasons: [...final.reasons, ...reject] })
        .where(and(eq(searchCandidates.searchId, searchId), eq(searchCandidates.creatorId, c.id)));
    }
    stats.qualified = qualified;
    await db.update(searches).set({ status: "done", stats, finishedAt: new Date(), progress: null, error: null }).where(eq(searches.id, searchId));
  } catch (e) {
    if (e instanceof Cancelled) {
      await db.update(searches).set({ finishedAt: new Date(), progress: null, stats }).where(eq(searches.id, searchId));
      return;
    }
    await db
      .update(searches)
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
