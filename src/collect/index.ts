import { and, eq, gte, sql } from "drizzle-orm";
import { ContentItemSchema, type ContentItem, type ContentItemInput } from "@/core/contract";
import type { Db } from "@/db/client";
import { contentItems } from "@/db/schema";
import { NoKeyAvailableError } from "@/keys/router";
import { fetchFirecrawl } from "./firecrawl";
import { fetchInstagramHashtag, fetchInstagramProfiles } from "./instagram";
import { fetchLocal, LocalMiss } from "./local";

export type Target =
  | { type: "url"; url: string }
  | { type: "instagram-profile"; username: string }
  | { type: "instagram-hashtag"; tag: string; limit?: number };

export type CollectResult = { items: ContentItem[]; cached: boolean; notes: string[] };

const CACHE_MS = 24 * 3600_000;
const IG_PROFILE = /^https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9._]+)\/?(?:\?.*)?$/;
const IG_RESERVED = new Set(["p", "reel", "reels", "explore", "stories", "tv", "accounts"]);

export async function saveItems(db: Db, inputs: ContentItemInput[]): Promise<ContentItem[]> {
  const items = inputs.map((i) => ContentItemSchema.parse(i));
  if (items.length === 0) return items;
  await db
    .insert(contentItems)
    .values(items.map((i) => ({
      source: i.source, externalId: i.id, kind: i.kind, url: i.url,
      authorUsername: i.author?.username ?? null, data: i, fetchedAt: i.fetchedAt,
    })))
    .onConflictDoUpdate({
      target: [contentItems.source, contentItems.externalId],
      set: {
        data: sql`excluded.data`, url: sql`excluded.url`, kind: sql`excluded.kind`,
        authorUsername: sql`excluded.author_username`, fetchedAt: sql`excluded.fetched_at`,
      },
    });
  return items;
}

async function collectUrl(db: Db, url: string, notes: string[]): Promise<ContentItemInput[]> {
  try {
    return [await fetchLocal(url)];
  } catch (e) {
    if (!(e instanceof LocalMiss)) throw e;
    notes.push(`Локально не вдалося (${e.message}) — використано Firecrawl`);
  }
  try {
    return [await fetchFirecrawl(db, url)];
  } catch (e) {
    if (e instanceof NoKeyAvailableError) throw new Error(`${notes.at(-1)?.replace(" — використано Firecrawl", "")}, а вільного ключа Firecrawl немає`);
    throw e;
  }
}

/** Єдина точка входу збирача: обирає адаптер, зберігає результат, повертає ContentItem[]. */
export async function collect(db: Db, target: Target, opts: { fresh?: boolean } = {}): Promise<CollectResult> {
  const notes: string[] = [];
  if (target.type === "url") {
    const parsed = new URL(target.url);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("Підтримуються лише адреси http(s)");
    const ig = target.url.match(IG_PROFILE);
    if (ig && !IG_RESERVED.has(ig[1])) return collect(db, { type: "instagram-profile", username: ig[1] }, opts);

    if (!opts.fresh) {
      const since = new Date(Date.now() - CACHE_MS);
      const cached = await db.select().from(contentItems)
        .where(and(eq(contentItems.source, "web"), eq(contentItems.externalId, target.url), gte(contentItems.fetchedAt, since)));
      if (cached.length) return { items: cached.map((c) => ContentItemSchema.parse(c.data)), cached: true, notes };
    }
    return { items: await saveItems(db, await collectUrl(db, target.url, notes)), cached: false, notes };
  }
  const inputs =
    target.type === "instagram-profile"
      ? await fetchInstagramProfiles(db, [target.username])
      : await fetchInstagramHashtag(db, target.tag, Math.min(Math.max(target.limit ?? 20, 1), 200));
  if (inputs.length === 0) notes.push("Instagram нічого не повернув — перевірте назву");
  return { items: await saveItems(db, inputs), cached: false, notes };
}
