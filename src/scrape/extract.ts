import * as cheerio from "cheerio";
import { z } from "zod";
import type { Db } from "@/db/client";
import type { ScrapeField } from "@/db/schema";
import { chatJson } from "@/llm/client";

export type Row = Record<string, string | number | null>;

const clean = (v: unknown): string | number | null => {
  if (v == null) return null;
  if (typeof v === "number") return v;
  const s = String(typeof v === "object" ? ((v as any).name ?? (v as any)["@id"] ?? JSON.stringify(v)) : v).replace(/\s+/g, " ").trim();
  return s ? s.slice(0, 2000) : null;
};

/** Усі вузли JSON-LD сторінки, включно з вкладеними в @graph. */
function jsonLdNodes($: cheerio.CheerioAPI): any[] {
  const nodes: any[] = [];
  const walk = (n: any, depth = 0) => {
    if (!n || depth > 6) return;
    if (Array.isArray(n)) return n.forEach((x) => walk(x, depth + 1));
    if (typeof n !== "object") return;
    if (n["@type"]) nodes.push(n);
    if (n["@graph"]) walk(n["@graph"], depth + 1);
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      walk(JSON.parse($(el).html() ?? ""));
    } catch {}
  });
  return nodes;
}

const isType = (n: any, ...types: string[]) => [n["@type"]].flat().some((t) => types.includes(String(t)));

/**
 * Автоматичний витяг без налаштувань: розмітка schema.org (товар, стаття, організація),
 * далі Open Graph і звичайні метатеги. Для інтернет-магазинів дає назву, ціну, валюту й наявність.
 */
export function autoExtract(html: string, url: string): Row {
  const $ = cheerio.load(html);
  const meta = (...names: string[]) => {
    for (const n of names) {
      const v = $(`meta[property="${n}"], meta[name="${n}"], meta[itemprop="${n}"]`).first().attr("content")?.trim();
      if (v) return v;
    }
    return null;
  };
  const nodes = jsonLdNodes($);
  const product = nodes.find((n) => isType(n, "Product", "ProductGroup"));
  const article = nodes.find((n) => isType(n, "Article", "NewsArticle", "BlogPosting"));
  const row: Row = { type: product ? "product" : article ? "article" : (meta("og:type") ?? "page") };

  row.title = clean(product?.name ?? article?.headline) ?? meta("og:title", "twitter:title") ?? ($("h1").first().text().trim() || $("title").first().text().trim() || null);
  row.description = clean(product?.description ?? article?.description) ?? meta("og:description", "description");
  row.image = clean([product?.image ?? article?.image].flat()[0]?.url ?? [product?.image ?? article?.image].flat()[0]) ?? meta("og:image");

  if (product) {
    const offer = [product.offers].flat().filter(Boolean)[0] ?? {};
    const price = offer.price ?? offer.lowPrice ?? offer.priceSpecification?.price ?? [offer.offers].flat().filter(Boolean)[0]?.price;
    row.price = price != null && price !== "" && !Number.isNaN(Number(price)) ? Number(price) : clean(price);
    row.currency = clean(offer.priceCurrency ?? offer.priceSpecification?.priceCurrency);
    row.availability = clean(offer.availability)?.toString().replace(/^https?:\/\/schema\.org\//, "") ?? null;
    row.brand = clean(product.brand);
    row.sku = clean(product.sku ?? product.mpn ?? product.gtin13 ?? product.gtin);
    row.rating = product.aggregateRating?.ratingValue != null ? Number(product.aggregateRating.ratingValue) : null;
    row.reviews = product.aggregateRating?.reviewCount != null ? Number(product.aggregateRating.reviewCount) : (product.aggregateRating?.ratingCount != null ? Number(product.aggregateRating.ratingCount) : null);
  } else {
    // Магазини без JSON-LD часто дублюють ціну в метатегах.
    const price = meta("product:price:amount", "og:price:amount", "price");
    if (price) {
      row.price = Number.isNaN(Number(price)) ? price : Number(price);
      row.currency = meta("product:price:currency", "og:price:currency", "priceCurrency");
      row.availability = meta("product:availability", "og:availability");
    }
  }
  if (article) {
    row.author = clean([article.author].flat()[0]);
    row.published = clean(article.datePublished);
  } else if (!product) {
    row.author = meta("author", "article:author");
    row.published = meta("article:published_time", "date");
  }
  row.canonical = $('link[rel="canonical"]').attr("href") ?? url;
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)) as Row;
}

/** Витяг за CSS-селекторами: текст елемента або значення атрибута; кілька збігів — через « | ». */
export function selectorExtract(html: string, fields: ScrapeField[]): Row {
  const $ = cheerio.load(html);
  const row: Row = {};
  for (const f of fields) {
    if (!f.selector) continue;
    let values: string[] = [];
    try {
      values = $(f.selector).slice(0, 20).map((_, el) => (f.attr ? ($(el).attr(f.attr) ?? "") : $(el).text()).replace(/\s+/g, " ").trim()).get().filter(Boolean);
    } catch {
      row[f.name] = null; // некоректний селектор
      continue;
    }
    row[f.name] = values.length ? [...new Set(values)].join(" | ").slice(0, 2000) : null;
  }
  return row;
}

/** Розбір рядків «назва = селектор @атрибут» із форми. */
export function parseFields(text: string): ScrapeField[] {
  const fields: ScrapeField[] = [];
  for (const raw of text.split(/\r?\n|,(?![^\[]*\])/)) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq < 0) {
      fields.push({ name: line.slice(0, 40) });
      continue;
    }
    const name = line.slice(0, eq).trim().slice(0, 40);
    const rest = line.slice(eq + 1).trim();
    const at = rest.match(/^(.*?)\s+@([\w-]+)$/);
    if (name && rest) fields.push(at ? { name, selector: at[1].trim(), attr: at[2] } : { name, selector: rest });
  }
  return fields.slice(0, 30);
}

const AiRow = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

/** Витяг мовною моделлю: достатньо назвати поля звичайними словами. Витрачає ліміт моделі. */
export async function aiExtract(db: Db, text: string, fields: string[]): Promise<Row> {
  const reply = await chatJson(db, AiRow, [
    { role: "user", content:
      `Extract these fields from the web page text below: ${fields.map((f) => JSON.stringify(f)).join(", ")}.\n` +
      `Return ONLY a JSON object with exactly these keys. Use null when the page does not contain the value. ` +
      `Copy values as written on the page; do not guess. Prices as numbers without currency symbols when possible.\n\n` +
      `PAGE TEXT:\n${text.slice(0, 9000)}` },
  ], { purpose: "scrape-ai", maxTokens: 900 });
  return Object.fromEntries(fields.map((f) => [f, typeof reply[f] === "boolean" ? String(reply[f]) : (reply[f] ?? null)])) as Row;
}
