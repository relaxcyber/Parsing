import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { ContentItemSchema, type ContentItem, type ContentItemInput } from "@/core/contract";
import type { Db } from "@/db/client";
import { collectRuns, contentItems } from "@/db/schema";
import { NoKeyAvailableError } from "@/keys/router";
import { fetchFirecrawl } from "./firecrawl";
import { cleanHandle, fetchInstagramHashtag, fetchInstagramProfiles, type Batch, type Collected } from "./instagram";
import { fetchLocal, LocalMiss } from "./local";
import { assertPublicUrl, normalizeUrl } from "./net";
import { fetchScrapling, ScraplingMissing } from "./scrapling";

export type Target =
  | { type: "url"; url: string }
  | { type: "instagram-profile"; username: string }
  | { type: "instagram-hashtag"; tag: string; limit?: number };

export type CollectResult = { items: ContentItem[]; ids: number[]; cached: boolean; cachedAt?: Date; notes: string[]; skipped: string[] };

const HOUR = 3600_000;
/** Після цього часу «запущений» збір вважаємо покинутим (сервер перезапускали тощо). */
const STALE_RUN_MS = 20 * 60_000;
const IG_PROFILE = /^https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9._]+)\/?(?:\?.*)?$/;
const IG_RESERVED = new Set(["p", "reel", "reels", "explore", "stories", "tv", "accounts"]);

/** Ціль у канонічному вигляді + ключ кешу + строк придатності. */
function resolveTarget(target: Target): { target: Target; key: string; ttlMs: number } {
  if (target.type === "url") {
    const ig = target.url.match(IG_PROFILE);
    if (ig && !IG_RESERVED.has(ig[1])) return resolveTarget({ type: "instagram-profile", username: ig[1] });
    const url = normalizeUrl(target.url);
    return { target: { type: "url", url }, key: `url:${url}`, ttlMs: 24 * HOUR };
  }
  if (target.type === "instagram-profile") {
    const username = cleanHandle(target.username).toLowerCase();
    return { target: { type: "instagram-profile", username }, key: `ig-profile:${username}`, ttlMs: 24 * HOUR };
  }
  const tag = cleanHandle(target.tag).toLowerCase();
  const limit = Math.min(Math.max(Math.round(target.limit ?? 20), 1), 200);
  return { target: { type: "instagram-hashtag", tag, limit }, key: `ig-hashtag:${tag}:${limit}`, ttlMs: 6 * HOUR };
}

export type SaveResult = { items: ContentItem[]; ids: number[]; skipped: string[] };

/** Зберігає все, що пройшло контракт; один поганий елемент або дубль не скасовує решту пачки. */
export async function saveItems(db: Db, inputs: (Collected | ContentItemInput)[]): Promise<SaveResult> {
  const skipped: string[] = [];
  const unique = new Map<string, { item: ContentItem; raw: unknown }>();
  for (const input of inputs) {
    const { item, raw } = "item" in input ? input : { item: input, raw: undefined };
    const parsed = ContentItemSchema.safeParse(item);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      skipped.push(`${item?.id || "без id"}: ${issue.path.join(".")} — ${issue.message}`);
      continue;
    }
    const key = `${parsed.data.source}:${parsed.data.id}`;
    // Дублі в одній пачці: лишаємо перший, але не губимо сирий запис.
    if (!unique.has(key)) unique.set(key, { item: parsed.data, raw });
  }
  const rows = [...unique.values()];
  const ids = new Map<string, number>();
  for (let i = 0; i < rows.length; i += 100) {
    const saved = await db
      .insert(contentItems)
      .values(rows.slice(i, i + 100).map(({ item, raw }) => ({
        source: item.source, externalId: item.id, kind: item.kind, url: item.url,
        authorUsername: item.author?.username ?? null, data: item, raw: raw ?? null, fetchedAt: item.fetchedAt,
      })))
      .onConflictDoUpdate({
        target: [contentItems.source, contentItems.externalId],
        set: {
          data: sql`excluded.data`, url: sql`excluded.url`, kind: sql`excluded.kind`,
          authorUsername: sql`excluded.author_username`, fetchedAt: sql`excluded.fetched_at`,
          raw: sql`coalesce(excluded.raw, ${contentItems.raw})`,
        },
      })
      .returning({ id: contentItems.id, source: contentItems.source, externalId: contentItems.externalId });
    for (const s of saved) ids.set(`${s.source}:${s.externalId}`, s.id);
  }
  return { items: rows.map((r) => r.item), ids: rows.map((r) => ids.get(`${r.item.source}:${r.item.id}`)!), skipped };
}

/** Безкоштовні локальні способи — від найшвидшого до найпотужнішого. */
const LOCAL_TIERS: { name: string; run: (url: string) => Promise<ContentItemInput> }[] = [
  { name: "Прямий запит", run: fetchLocal },
  { name: "Scrapling", run: (url) => fetchScrapling(url, "http") },
  { name: "Scrapling (браузер)", run: (url) => fetchScrapling(url, "stealth") },
];

async function collectUrl(db: Db, url: string, notes: string[]): Promise<Batch> {
  await assertPublicUrl(url);
  const misses: string[] = [];
  for (const tier of LOCAL_TIERS) {
    try {
      const item = await tier.run(url);
      if (misses.length) notes.push(`${misses.join("; ")} — спрацював ${tier.name}`);
      return { collected: [{ item: { ...item, id: url } }], skipped: [] };
    } catch (e) {
      if (!(e instanceof LocalMiss)) throw e;
      // Сторінки немає (404/410, не HTML) — платні способи не допоможуть, кредит не витрачаємо.
      if (e.definitive) throw new Error(`Сторінка недоступна: ${e.message}`);
      if (!(e instanceof ScraplingMissing)) misses.push(`${tier.name}: ${e.message}`);
    }
  }
  try {
    const item = await fetchFirecrawl(db, url);
    notes.push(`${misses.join("; ")} — використано Firecrawl`);
    return { collected: [{ item }], skipped: [] };
  } catch (e) {
    if (e instanceof NoKeyAvailableError) throw new Error(`Локально не вдалося (${misses.join("; ")}), а вільного ключа Firecrawl немає`);
    throw e;
  }
}

export class AlreadyRunningError extends Error {}

/**
 * Єдина точка входу збирача: кеш за ціллю, захист від подвійного запуску,
 * вибір адаптера, збереження. Повертає елементи разом з їхніми id у базі.
 */
export async function collect(db: Db, input: Target, opts: { fresh?: boolean } = {}): Promise<CollectResult> {
  if (input.type === "url" && !URL.canParse(input.url)) throw new Error("Некоректна адреса");
  const { target, key, ttlMs } = resolveTarget(input);
  const notes: string[] = [];

  if (!opts.fresh) {
    const [last] = await db.select().from(collectRuns)
      .where(and(eq(collectRuns.targetKey, key), eq(collectRuns.status, "done"), gte(collectRuns.startedAt, new Date(Date.now() - ttlMs))))
      .orderBy(desc(collectRuns.startedAt)).limit(1);
    if (last?.itemIds.length) {
      const rows = await db.select().from(contentItems).where(inArray(contentItems.id, last.itemIds));
      const byId = new Map(rows.map((r) => [r.id, r]));
      const kept = last.itemIds.map((id) => byId.get(id)).filter((r) => r != null);
      const items = kept.map((r) => ContentItemSchema.safeParse(r.data)).flatMap((p) => (p.success ? [p.data] : []));
      if (items.length) return { items, ids: kept.map((r) => r.id), cached: true, cachedAt: last.startedAt, notes, skipped: [] };
    }
  }

  // Унікальний індекс «один running на ціль» не дає запустити той самий платний збір двічі.
  await db.update(collectRuns).set({ status: "failed", error: "перервано", finishedAt: new Date() })
    .where(and(eq(collectRuns.targetKey, key), eq(collectRuns.status, "running"), lt(collectRuns.startedAt, new Date(Date.now() - STALE_RUN_MS))));
  const [run] = await db.insert(collectRuns).values({ targetKey: key }).onConflictDoNothing().returning({ id: collectRuns.id });
  if (!run) throw new AlreadyRunningError("Цей збір уже виконується — дочекайтеся результату й оновіть сторінку");

  try {
    const batch =
      target.type === "url"
        ? await collectUrl(db, target.url, notes)
        : target.type === "instagram-profile"
          ? await fetchInstagramProfiles(db, [target.username])
          : await fetchInstagramHashtag(db, target.tag, target.limit!);
    const saved = await saveItems(db, batch.collected);
    const skipped = [...batch.skipped, ...saved.skipped];
    if (saved.items.length === 0 && target.type !== "url") notes.push("Instagram нічого не повернув — перевірте назву");
    await db.update(collectRuns)
      .set({ status: "done", itemIds: saved.ids, skipped: skipped.length, finishedAt: new Date() })
      .where(eq(collectRuns.id, run.id));
    return { items: saved.items, ids: saved.ids, cached: false, notes, skipped };
  } catch (e) {
    await db.update(collectRuns)
      .set({ status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 2000), finishedAt: new Date() })
      .where(eq(collectRuns.id, run.id));
    throw e;
  }
}
