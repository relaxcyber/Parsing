import * as cheerio from "cheerio";
import { extractEmails } from "@/search/signals";
import { classifyLinks, type LinkSummary } from "./links";

/**
 * Витяг контактів зі сторінки-візитки (Linktree, Stan Store, Beacons, власний сайт).
 * Дані беремо з усіх місць, де вони бувають: посилання й текст розмітки, __NEXT_DATA__
 * (Next.js Pages Router), потік React Server Components (App Router) і JSON-LD.
 */

export type Offer = { title: string; amount: number; currency: string; /** Схоже на ціну за UGC-послугу, а не на цифровий товар. */ ugcRate: boolean };

export type LinkPageData = LinkSummary & {
  format: "next-data" | "rsc" | "html";
  title?: string;
  /** Email із позначкою, звідки взято: mailto надійніший за текст. */
  emails: { email: string; via: "mailto" | "text" }[];
  links: string[];
  offers: Offer[];
};

/** Рядки з довільного JSON — так не залежимо від точної схеми конкретного сервісу. */
function collectStrings(node: unknown, out: string[], depth = 0): void {
  if (depth > 40 || out.length > 20_000) return;
  if (typeof node === "string") {
    if (node.length > 2 && node.length < 4000) out.push(node);
  } else if (Array.isArray(node)) {
    for (const v of node) collectStrings(v, out, depth + 1);
  } else if (node && typeof node === "object") {
    for (const v of Object.values(node)) collectStrings(v, out, depth + 1);
  }
}

/** Фрагменти RSC лежать у JS-рядках; розкодовуємо їх як JSON-рядки, а не ручною заміною лапок. */
function rscText(html: string): string {
  const parts: string[] = [];
  for (const m of html.matchAll(/self\.__next_f\.push\(\[\s*\d+\s*,\s*("(?:[^"\\]|\\.)*")\s*\]\)/g)) {
    try {
      parts.push(JSON.parse(m[1]));
    } catch {}
  }
  return parts.join("");
}

const URL_RE = /https?:\/\/[^\s"'<>\\)\]]+/g;
const CURRENCY: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP" };
const UGC_SERVICE = /\b(ugc|video|reel|tiktok|content|package|bundle|testimonial|unboxing|hook|deliverable|usage rights|per (video|post)|photos?)\b/i;
const NOT_SERVICE = /\b(ebook|e-book|guide|course|template|preset|masterclass|webinar|checklist|workbook|newsletter|coaching|consult|community|membership)\b/i;

function offersFrom(text: string): Offer[] {
  const offers: Offer[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\n+/)) {
    for (const m of line.matchAll(/([$€£])\s?(\d{1,3}(?:[,.]\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g)) {
      const amount = Number(m[2].replace(/,(?=\d{3})/g, ""));
      if (!(amount > 0)) continue;
      const title = line.replace(/\s+/g, " ").trim().slice(0, 140);
      const key = `${title}|${amount}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Ціна від $30 поруч зі словами про зйомку — ймовірна ставка; курси й гайди — це товари.
      offers.push({ title, amount, currency: CURRENCY[m[1]], ugcRate: amount >= 30 && amount <= 5000 && UGC_SERVICE.test(title) && !NOT_SERVICE.test(title) });
    }
  }
  return offers.slice(0, 40);
}

export function extractLinkPage(html: string, pageUrl: string): LinkPageData {
  const $ = cheerio.load(html);
  const strings: string[] = [];
  let format: LinkPageData["format"] = "html";

  const nextData = $("#__NEXT_DATA__").html();
  if (nextData) {
    try {
      collectStrings(JSON.parse(nextData)?.props?.pageProps, strings);
      format = "next-data";
    } catch {}
  }
  const rsc = rscText(html);
  if (rsc) {
    strings.push(rsc);
    if (format === "html") format = "rsc";
  }
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      collectStrings(JSON.parse($(el).html() ?? ""), strings);
    } catch {}
  });

  const hrefs: string[] = [];
  const mailto: string[] = [];
  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") ?? "").trim();
    if (/^mailto:/i.test(href)) mailto.push(decodeURIComponent(href.slice(7).split("?")[0]));
    else if (/^https?:\/\//i.test(href)) hrefs.push(href);
  });
  for (const s of strings) {
    if (/^mailto:/i.test(s)) mailto.push(s.slice(7).split("?")[0]);
    for (const u of s.match(URL_RE) ?? []) hrefs.push(u);
  }

  const title = $("title").first().text().trim() || undefined;
  $("script, style, noscript, svg").remove();
  $("br").replaceWith("\n");
  $("p, div, li, h1, h2, h3, h4, section, a, button").each((_, el) => {
    $(el).append("\n");
  });
  const visible = $("body").text().replace(/[ \t ]+/g, " ");
  const corpus = [visible, ...strings].join("\n");

  // Власні адреси сервісу (підтримка, приклади) контактами автора не вважаємо.
  const own = new URL(pageUrl).hostname.replace(/^www\./, "");
  const service = (e: string) => e.endsWith(`@${own}`) || /@(sentry|example|email|domain)\.|\.(png|jpe?g|webp|gif|svg)$/i.test(e) || /^(support|help|hello|privacy|legal|abuse|noreply|no-reply)@(linktr\.ee|beacons\.ai|stan\.store)/i.test(e);
  const emails: LinkPageData["emails"] = [];
  for (const e of extractEmails(mailto.join(" "))) if (!service(e)) emails.push({ email: e, via: "mailto" });
  for (const e of extractEmails(corpus)) if (!service(e) && !emails.some((x) => x.email === e)) emails.push({ email: e, via: "text" });

  const links = [...new Set(hrefs.map((u) => u.replace(/[.,;]+$/, "")))].filter((u) => {
    try {
      const h = new URL(u).hostname;
      // Службові ресурси сторінки (стилі, шрифти, CDN) — не посилання автора.
      return !h.endsWith(own) && !/(cloudfront\.net|googleapis\.com|gstatic\.com|sentry\.io|w3\.org|schema\.org|cdn\.|assets\.|static\.)/.test(h) && !/\.(js|css|png|jpe?g|webp|svg|woff2?|ico)(\?|$)/i.test(u);
    } catch {
      return false;
    }
  }).slice(0, 100);

  return { format, title, emails: emails.slice(0, 10), links, offers: offersFrom(visible), ...classifyLinks(links) };
}
