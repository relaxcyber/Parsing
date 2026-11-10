import * as cheerio from "cheerio";
import type { ContentItemInput } from "@/core/contract";

/** Локальний спосіб не впорався (захист, JS-рендеринг) — каскад іде далі. */
export class LocalMiss extends Error {}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const CHALLENGE = /Just a moment\.\.\.|cf-challenge|challenge-platform|Attention Required!|captcha-delivery|Access Denied/i;
const MAX_TEXT = 50_000;

const absolute = (href: string | undefined, base: string) => {
  try {
    return href ? new URL(href, base).toString() : undefined;
  } catch {
    return undefined;
  }
};

export function extractHtml(html: string, url: string, now = new Date()): ContentItemInput {
  const $ = cheerio.load(html);
  const meta = (...names: string[]) => {
    for (const n of names) {
      const v = $(`meta[property="${n}"], meta[name="${n}"]`).first().attr("content")?.trim();
      if (v) return v;
    }
  };
  const title = meta("og:title", "twitter:title") ?? ($("title").first().text().trim() || undefined);
  const image = absolute(meta("og:image", "twitter:image"), url);

  $("script, style, noscript, svg, nav, header, footer, aside, form, iframe").remove();
  const root = $("article").first().length ? $("article").first() : $("main").first().length ? $("main").first() : $("body");
  const text = root.text().replace(/[ \t\r\f\v]+/g, " ").replace(/\s*\n\s*/g, "\n").trim().slice(0, MAX_TEXT);

  const authorName = meta("author", "article:author");
  const published = meta("article:published_time", "og:article:published_time", "date");
  const publishedAt = published && !Number.isNaN(Date.parse(published)) ? new Date(published) : undefined;

  return {
    id: url, source: "web", kind: "article", url, title,
    text: text || meta("og:description", "description"),
    lang: $("html").attr("lang")?.trim() || undefined,
    author: authorName && !/^https?:/.test(authorName) ? { displayName: authorName } : null,
    media: image ? [{ type: "image", url: image }] : [],
    publishedAt, fetchedAt: now, via: "local",
  };
}

/** Спільна для всіх локальних способів перевірка: це справжній вміст, а не заглушка захисту? */
export function checkedItem(html: string, url: string, via: ContentItemInput["via"]): ContentItemInput {
  if (CHALLENGE.test(html.slice(0, 20_000))) throw new LocalMiss("сторінка захисту від ботів");
  const item = extractHtml(html, url);
  // Майже порожній текст при великому HTML — сторінка малюється скриптами.
  if ((item.text?.length ?? 0) < 200 && html.length > 5_000) throw new LocalMiss("вміст рендериться скриптами");
  return { ...item, via };
}

export async function fetchLocal(url: string): Promise<ContentItemInput> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8", "accept-language": "en-US,en;q=0.9,uk;q=0.8" },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new LocalMiss(`мережа: ${e instanceof Error ? e.message : e}`);
  }
  if (!res.ok) throw new LocalMiss(`HTTP ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (!/html|xml/.test(type)) throw new LocalMiss(`не HTML (${type || "невідомий тип"})`);
  const html = await res.text();
  return checkedItem(html, url, "local");
}
