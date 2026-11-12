import type { ContentItemInput } from "@/core/contract";
import type { Db } from "@/db/client";
import { NotChargedError, withKey } from "@/keys/router";
import { postJson } from "./http";

const httpUrl = (v: unknown) => (typeof v === "string" && /^https?:\/\//.test(v) ? v : undefined);

export function mapFirecrawl(data: any, url: string, now = new Date()): ContentItemInput {
  const m = data?.metadata ?? {};
  const image = httpUrl(m.ogImage) ?? httpUrl(m["og:image"]);
  const published = m.publishedTime ?? m["article:published_time"];
  return {
    id: url, source: "web", kind: "article", url,
    title: m.ogTitle ?? m.title ?? undefined,
    text: typeof data?.markdown === "string" ? data.markdown.slice(0, 50_000) : undefined,
    lang: typeof m.language === "string" ? m.language : undefined,
    author: typeof m.author === "string" && m.author ? { displayName: m.author } : null,
    media: image ? [{ type: "image", url: image }] : [],
    publishedAt: published && !Number.isNaN(Date.parse(published)) ? new Date(published) : undefined,
    fetchedAt: now, via: "firecrawl",
  };
}

export async function fetchFirecrawl(db: Db, url: string): Promise<ContentItemInput> {
  return withKey(
    db,
    "firecrawl",
    async (key, usage) => {
      const res = await postJson("https://api.firecrawl.dev/v1/scrape", key.secret, { url, formats: ["markdown"] }, 90_000);
      if (!res?.success || !res.data) throw new NotChargedError(`Firecrawl: ${res?.error ?? "порожня відповідь"}`);
      usage.units = Number(res.data.metadata?.creditsUsed) || 1;
      return mapFirecrawl(res.data, url);
    },
    { purpose: "scrape", retryTransient: true },
  );
}

/** Пошук у вебі через Firecrawl: знаходить сторінки (у т.ч. профілі Instagram) за запитом. */
export async function searchFirecrawl(db: Db, query: string, limit: number): Promise<ContentItemInput[]> {
  return withKey(
    db,
    "firecrawl",
    async (key, usage) => {
      const res = await postJson("https://api.firecrawl.dev/v1/search", key.secret, { query, limit }, 60_000);
      if (!res?.success || !Array.isArray(res.data)) throw new NotChargedError(`Firecrawl: ${res?.error ?? "порожня відповідь"}`);
      usage.units = Number(res.creditsUsed) || Math.max(1, res.data.length);
      const now = new Date();
      return res.data
        .filter((d: any) => httpUrl(d?.url))
        .map((d: any): ContentItemInput => ({
          id: d.url, source: "web", kind: "article", url: d.url, title: d.title || undefined, text: d.description || undefined,
          fetchedAt: now, via: "firecrawl",
        }));
    },
    { purpose: "web-search", retryTransient: true },
  );
}
