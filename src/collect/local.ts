import * as cheerio from "cheerio";
import type { ContentItemInput } from "@/core/contract";
import { assertPublicUrl } from "./net";

/** Локальний спосіб не впорався (захист, JS-рендеринг) — каскад іде далі. */
export class LocalMiss extends Error {
  /** definitive: сторінки справді немає — платні способи пробувати марно. */
  constructor(message: string, public definitive = false) {
    super(message);
  }
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const CHALLENGE = /Just a moment\.\.\.|cf-challenge|challenge-platform|Attention Required!|captcha-delivery|Access Denied/i;
const MAX_TEXT = 50_000;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const BLOCKS = "p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, div, section, tr, dt, dd, figcaption";

const absolute = (href: string | undefined, base: string) => {
  try {
    const u = href ? new URL(href, base) : undefined;
    return u && /^https?:$/.test(u.protocol) ? u.toString() : undefined;
  } catch {
    return undefined;
  }
};

/** Текст із межами абзаців: cheerio сам склеює сусідні блоки без пробілів. */
function blockText($: cheerio.CheerioAPI, root: cheerio.Cheerio<any>): string {
  root.find("br").replaceWith("\n");
  root.find(BLOCKS).each((_, el) => {
    $(el).prepend("\n\n").append("\n\n");
  });
  return root
    .text()
    .replace(/[ \t\r\f\v ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

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
  const text = blockText($, root).slice(0, MAX_TEXT);

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
  const item = extractHtml(html, url);
  const textLen = item.text?.length ?? 0;
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "";
  // Слова на кшталт «Access Denied» у довгій статті — це тема статті, а не заглушка.
  // У короткій сторінці шукаємо по всьому документу: скрипт перевірки буває глибоко після стилів.
  if (CHALLENGE.test(title) || (textLen < 1500 && CHALLENGE.test(html))) {
    throw new LocalMiss("сторінка захисту від ботів");
  }
  // Сторінка малюється в браузері: тексту майже немає, а розмітки без стилів, SVG і вбудованих
  // даних (JSON-LD) багато — або тексту немає зовсім, а скрипти є (компактний SPA).
  const scripts = html.match(/<script\b/gi)?.length ?? 0;
  const markup = html.replace(/<(style|svg)\b[\s\S]*?<\/\1>|<script\b[^>]*type=["']application\/(ld\+)?json["'][\s\S]*?<\/script>/gi, "").length;
  if ((textLen < 200 && markup > 5_000 && scripts >= 3) || (textLen < 50 && scripts >= 1)) {
    throw new LocalMiss("вміст рендериться скриптами");
  }
  return { ...item, via };
}

/** Читає тіло не більше MAX_BYTES і декодує з урахуванням кодування сторінки. */
async function readBody(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (declared > MAX_BYTES * 4) throw new LocalMiss("сторінка завелика", true);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
      if (size >= MAX_BYTES) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  }
  const bytes = Buffer.concat(chunks).subarray(0, MAX_BYTES);
  const head = bytes.subarray(0, 2048).toString("latin1");
  const charset =
    res.headers.get("content-type")?.match(/charset=["']?([\w-]+)/i)?.[1] ??
    head.match(/<meta[^>]+charset=["']?\s*([\w-]+)/i)?.[1] ??
    "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export async function fetchLocal(url: string): Promise<ContentItemInput> {
  let current = url;
  let res: Response | undefined;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(current); // кожен перехід перевіряємо заново
    try {
      res = await fetch(current, {
        headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8", "accept-language": "en-US,en;q=0.9,uk;q=0.8" },
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new LocalMiss(`мережа: ${e instanceof Error ? e.message : e}`);
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) break;
    await res.body?.cancel().catch(() => {});
    current = new URL(location, current).toString();
    if (hop === MAX_REDIRECTS) throw new LocalMiss("забагато переадресацій", true);
  }
  if (!res) throw new LocalMiss("мережа: немає відповіді");
  if (res.status === 404 || res.status === 410) throw new LocalMiss(`HTTP ${res.status} — сторінки не існує`, true);
  if (!res.ok) throw new LocalMiss(`HTTP ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (type && !/html|xml/.test(type)) throw new LocalMiss(`не HTML (${type})`, true);
  return checkedItem(await readBody(res), current, "local");
}
