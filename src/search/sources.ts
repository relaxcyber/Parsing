import { collect, collectProfiles } from "@/collect";
import { cleanHandle } from "@/collect/instagram";
import { TIKTOK_HANDLE, tiktokHandles } from "@/collect/tiktok";
import type { ContentItem } from "@/core/contract";
import type { Db } from "@/db/client";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { creators, searchCandidates, type Search, type SearchSources } from "@/db/schema";

/**
 * Джерела кандидатів. Кожне джерело — окреме завдання з оцінкою вартості: автопілот запускає їх
 * по черзі й зупиняється, коли досягнуто мети або бюджету. Мітка джерела зберігається в кандидата,
 * щоб рахувати ціну ліда за кожним джерелом.
 */

/** Ціни Apify за результат (тариф FREE на листопад 2026; фактичну вартість рахує Apify після запуску). */
export const PRICE = { post: 0.0026, profile: 0.0026, search: 0.0027, tagged: 0.0027, place: 0.0027, comment: 0.0026 } as const;

export type Found = {
  username: string;
  displayName?: string;
  externalId?: string;
  posts: { item: ContentItem; id: number }[];
};
export type SourceRun = { found: Found[]; costUsd: number; notes: string[]; posts: number };
export type SourceTask = { label: string; estimateUsd: number; run: (db: Db) => Promise<SourceRun> };

const IG_HANDLE = /instagram\.com\/([A-Za-z0-9._]{2,30})(?:[/?#]|$)/i;
const IG_RESERVED = new Set(["p", "reel", "reels", "explore", "stories", "tv", "accounts", "about", "developer", "legal", "directory"]);

export const sourcesOf = (s: Pick<Search, "sources">): SearchSources => ({
  bioQueries: [], competitors: [], seeds: [], places: [], usernames: [], webQueries: [], ...s.sources,
});

/** Групує зібрані елементи за автором: дописи — до автора, профілі з пошуку — як автори без дописів. */
export function groupByAuthor(items: ContentItem[], ids: number[], skip: Set<string> = new Set()): Found[] {
  const by = new Map<string, Found>();
  items.forEach((item, i) => {
    const username = item.author?.username?.toLowerCase();
    if (!username || skip.has(username)) return;
    const f = by.get(username) ?? { username, posts: [] };
    f.displayName ??= item.author?.displayName;
    f.externalId ??= item.author?.id;
    if (item.kind === "post" || item.kind === "video") f.posts.push({ item, id: ids[i] });
    by.set(username, f);
  });
  return [...by.values()];
}

function collectTask(label: string, estimateUsd: number, target: Parameters<typeof collect>[1], skip?: Set<string>): SourceTask {
  return {
    label, estimateUsd,
    run: async (db) => {
      const r = await collect(db, target);
      const found = groupByAuthor(r.items, r.ids, skip);
      return { found, costUsd: r.costUsd, notes: r.notes.map((n) => `${label}: ${n}`), posts: r.items.filter((i) => i.kind !== "profile").length };
    },
  };
}

/** Пошук у вебі (Firecrawl) й імена TikTok із знайдених сторінок. */
function tiktokWebTask(label: string, query: string): SourceTask {
  return {
    label, estimateUsd: 0,
    run: async (db) => {
      const r = await collect(db, { type: "web-search", query, limit: 20 });
      const found = tiktokHandles(r.items.flatMap((i) => [i.url, i.text ?? "", i.title ?? ""])).map((username) => ({ username, posts: [] }));
      return { found, costUsd: 0, notes: r.notes.map((n) => `${label}: ${n}`), posts: 0 };
    },
  };
}

/**
 * TikTok: хештеги й пошук TikTok віддає лише своєму застосунку, тож авторів шукаємо через вебпошук
 * (site:tiktok.com), ваш список і TikTok-акаунти авторів, яких ваші пошуки Instagram уже відібрали.
 * Профілі потім перевіряються безкоштовно.
 */
export function planTikTokSources(s: Search): SourceTask[] {
  const src = sourcesOf(s);
  const tasks: SourceTask[] = [];
  for (const tag of s.hashtags) tasks.push(tiktokWebTask(`веб: #${tag}`, `site:tiktok.com "#${tag}"`));
  for (const q of src.bioQueries) tasks.push(tiktokWebTask(`веб: ${q}`, `site:tiktok.com ${q}`));
  for (const q of src.webQueries) tasks.push(tiktokWebTask(`веб: ${q}`, /tiktok/i.test(q) ? q : `site:tiktok.com ${q}`));
  if (src.usernames.length) {
    const names = [...new Set(src.usernames.flatMap((u) => (/tiktok\.com/i.test(u) ? tiktokHandles([u]) : [cleanHandle(u).toLowerCase()])).filter((u) => TIKTOK_HANDLE.test(u)))];
    tasks.push({ label: "ваш список", estimateUsd: 0, run: async () => ({ found: names.map((username) => ({ username, posts: [] })), costUsd: 0, notes: [], posts: 0 }) });
  }
  tasks.push({
    label: "TikTok авторів з бази Instagram", estimateUsd: 0,
    run: async (db) => {
      // Автори Instagram, які вже пройшли відбір у ваших пошуках і мають посилання на TikTok.
      const rows = await db.selectDistinct({ socials: creators.socials, links: creators.links }).from(creators)
        .innerJoin(searchCandidates, eq(searchCandidates.creatorId, creators.id))
        .where(and(eq(creators.platform, "instagram"), eq(searchCandidates.stage, "qualified"), isNotNull(creators.socials),
          sql`(${creators.socials} ? 'tiktok' or ${creators.links}::text ilike '%tiktok.com/@%')`));
      const names = new Set<string>();
      for (const r of rows) {
        const h = r.socials?.tiktok?.toLowerCase();
        if (h && TIKTOK_HANDLE.test(h)) names.add(h);
        tiktokHandles(r.links).forEach((x) => names.add(x));
      }
      return { found: [...names].map((username) => ({ username, posts: [] })), costUsd: 0, notes: [], posts: 0 };
    },
  });
  return tasks;
}

export function planSources(s: Search, extraTags: string[] = []): SourceTask[] {
  if (s.platform === "tiktok") return planTikTokSources(s);
  const src = sourcesOf(s);
  const tasks: SourceTask[] = [];
  for (const tag of [...s.hashtags, ...extraTags]) {
    tasks.push(collectTask(`#${tag}`, s.postsPerTag * PRICE.post, { type: "instagram-hashtag", tag, limit: s.postsPerTag }));
  }
  const searchLimit = Math.min(s.postsPerTag, 50);
  for (const q of src.bioQueries) tasks.push(collectTask(`пошук: ${q}`, searchLimit * PRICE.search, { type: "instagram-search", query: q, limit: searchLimit }));
  for (const brand of src.competitors) {
    const handle = cleanHandle(brand).toLowerCase();
    // Сам бренд — не кандидат.
    tasks.push(collectTask(`відмітки @${handle}`, s.postsPerTag * PRICE.tagged, { type: "instagram-tagged", username: handle, limit: s.postsPerTag }, new Set([handle])));
  }
  for (const q of src.places) tasks.push(collectTask(`місце: ${q}`, s.postsPerTag * PRICE.place, { type: "instagram-place", query: q, limit: s.postsPerTag }));
  for (const q of src.webQueries) {
    tasks.push({
      label: `веб: ${q}`, estimateUsd: 0,
      run: async (db) => {
        const r = await collect(db, { type: "web-search", query: q, limit: 20 });
        const names = [...new Set(r.items.map((i) => i.url.match(IG_HANDLE)?.[1]?.toLowerCase()).filter((h): h is string => !!h && !IG_RESERVED.has(h)))];
        return { found: names.map((username) => ({ username, posts: [] })), costUsd: 0, notes: r.notes.map((n) => `веб: ${q}: ${n}`), posts: 0 };
      },
    });
  }
  if (src.usernames.length) {
    const names = [...new Set(src.usernames.map((u) => cleanHandle(u).toLowerCase()).filter((u) => /^[a-z0-9._]{2,30}$/.test(u)))];
    tasks.push({ label: "ваш список", estimateUsd: 0, run: async () => ({ found: names.map((username) => ({ username, posts: [] })), costUsd: 0, notes: [], posts: 0 }) });
  }
  return tasks;
}

/**
 * «Схожі на зразки»: хештеги, якими найчастіше користуються ваші еталонні автори, стають
 * додатковими джерелами. Профілі зразків — платні (по ціні профілю), але їх кілька.
 */
export async function seedTags(db: Db, seeds: string[], used: Set<string>, max = 5): Promise<{ tags: string[]; costUsd: number }> {
  const names = [...new Set(seeds.map((s) => cleanHandle(s).toLowerCase()).filter(Boolean))].slice(0, 10);
  if (!names.length) return { tags: [], costUsd: 0 };
  const { batch } = await collectProfiles(db, names);
  const counts = new Map<string, number>();
  for (const { item } of batch.collected) {
    if (item.kind === "profile") continue;
    for (const t of item.tags ?? []) {
      const tag = t.toLowerCase();
      if (tag.length >= 3 && !used.has(tag)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  const tags = [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, max).map(([t]) => t);
  return { tags, costUsd: batch.costUsd ?? 0 };
}

/** Нові хештеги з дописів авторів, що пройшли відбір: «де ще шукати схожих». */
export function expansionTags(postsOfQualified: ContentItem[][], used: Set<string>, stop: string[], max = 3): string[] {
  const counts = new Map<string, number>();
  for (const posts of postsOfQualified) {
    const tags = new Set(posts.flatMap((p) => p.tags.map((t) => t.toLowerCase())));
    for (const t of tags) if (t.length >= 3 && !used.has(t) && !stop.some((w) => t.includes(w.toLowerCase()))) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  // Тег має бути щонайменше у двох різних авторів — інакше це особистий тег одного автора.
  return [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, max).map(([t]) => t);
}
