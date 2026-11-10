import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { extractFrames } from "@/audit/frames";
import { scrapeJobs, scrapeResults } from "@/db/schema";
import { detectCountry, detectLanguage, normalizeCountry } from "@/enrich/geo";
import { autoExtract, parseFields, selectorExtract } from "@/scrape/extract";
import { parseUrls, requeueInterruptedJobs, runNextScrapeJob } from "@/scrape/jobs";
import { calibrate } from "@/search/calibrate";
import { addTestKey, testDb } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

describe("country and language", () => {
  it("reads flags, places and Amazon storefront domains", () => {
    expect(detectCountry({ bio: "UGC creator 🇬🇧 | skincare" })).toMatchObject({ country: "GB", confidence: 0.7 });
    expect(detectCountry({ bio: "📍 Los Angeles based creator" })).toMatchObject({ country: "US", confidence: 0.6 });
    expect(detectCountry({ bio: "mom of two", links: ["https://www.amazon.de/shop/anna"] }).country).toBe("DE");
    expect(detectCountry({ bio: "London 🇬🇧", links: ["https://www.amazon.com/shop/x"] })).toMatchObject({ country: "GB", confidence: 1 });
    expect(detectCountry({ bio: "just vibes" })).toEqual({ country: null, confidence: 0, signals: [] });
    expect([normalizeCountry("uk"), normalizeCountry(" us ")]).toEqual(["GB", "US"]);
  });
  it("detects language by script and by function words", () => {
    expect(detectLanguage("Мій догляд за шкірою щодня, і це найкраще").language).toBe("uk");
    expect(detectLanguage("Это мой ежедневный уход, вы просили обзор").language).toBe("ru");
    expect(detectLanguage("This is my favourite skincare routine and you will love it for the price").language).toBe("en");
    expect(detectLanguage("Esta es mi rutina de cuidado de la piel y es la mejor para el invierno").language).toBe("es");
    expect(detectLanguage("ok #ugc @brand").language).toBeNull();
  });
});

describe("calibration", () => {
  it("needs ten verdicts of both kinds, then suggests the threshold that agrees most", () => {
    expect(calibrate([{ quality: 80, verdict: "yes" }], 70)).toEqual({ labeled: 1, current: { threshold: 70, agree: 1 }, best: null });
    // Людина бере авторів від 55 балів: поріг 70 відкидає трьох хороших.
    const rows = [50, 52, 40, 45, 30].map((quality) => ({ quality, verdict: "no" as const }))
      .concat([56, 60, 65, 72, 80, 90].map((quality) => ({ quality, verdict: "yes" as const })) as any);
    const cal = calibrate(rows, 70);
    expect(cal.current.agree).toBe(8);
    expect(cal.best).toEqual({ threshold: 55, agree: 11 });
  });
});

describe("video frames", () => {
  it("extracts frames from inside a real video file", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "vid-"));
    const file = path.join(dir, "v.mp4");
    execFileSync(ffmpegPath as unknown as string, ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=4:size=320x240:rate=10", "-pix_fmt", "yuv420p", "-y", file]);
    const video = readFileSync(file);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(video), { headers: { "content-type": "video/mp4" } })));
    const frames = await extractFrames("https://cdn.example/v.mp4", 3);
    expect(frames).toHaveLength(3);
    expect((await sharp(frames[0]).metadata()).width).toBe(320);
    // три кадри з різних моментів — це різні зображення
    expect(new Set(frames.map((f) => f.toString("base64").slice(-200))).size).toBe(3);
  });
  it("returns nothing for a file that is not a video", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(20_000), { headers: { "content-type": "video/mp4" } })));
    expect(await extractFrames("https://cdn.example/broken.mp4")).toEqual([]);
  });
});

const productPage = (name: string, price: number, extra = "") => `<html><head><title>${name}</title>
  <meta property="og:image" content="https://shop.example/img.jpg">
  <script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": [
    { "@type": "BreadcrumbList" },
    { "@type": "Product", name, sku: "SKU-1", brand: { "@type": "Brand", name: "Glow" }, description: "A serum",
      offers: { "@type": "Offer", price: String(price), priceCurrency: "EUR", availability: "https://schema.org/InStock" },
      aggregateRating: { ratingValue: "4.6", reviewCount: 128 } },
  ] })}</script></head><body><h1 class="t">${name}</h1><span class="price">€${price}</span><img class="main" src="/a.jpg">${extra}</body></html>`;

describe("field extraction", () => {
  it("reads a product from schema.org markup with no configuration", () => {
    expect(autoExtract(productPage("Serum", 24.9), "https://shop.example/p/1")).toMatchObject({
      type: "product", title: "Serum", price: 24.9, currency: "EUR", availability: "InStock", brand: "Glow", sku: "SKU-1", rating: 4.6, reviews: 128,
      image: "https://shop.example/img.jpg",
    });
  });
  it("falls back to meta tags and the heading", () => {
    const html = `<html><head><meta property="product:price:amount" content="19.00"><meta property="product:price:currency" content="USD"></head><body><h1>Cream</h1></body></html>`;
    expect(autoExtract(html, "https://s.example/c")).toMatchObject({ title: "Cream", price: 19, currency: "USD" });
  });
  it("extracts by CSS selectors, including attributes, and survives a bad selector", () => {
    const fields = parseFields("title = h1.t\nprice = .price\nphoto = img.main @src\nbroken = div[[\nmissing = .nope");
    expect(fields[2]).toEqual({ name: "photo", selector: "img.main", attr: "src" });
    expect(selectorExtract(productPage("Serum", 24.9), fields)).toEqual({ title: "Serum", price: "€24.9", photo: "/a.jpg", broken: null, missing: null });
    expect(parseFields("ціна, назва, наявність")).toEqual([{ name: "ціна" }, { name: "назва" }, { name: "наявність" }]);
  });
  it("cleans a pasted URL list", () => {
    expect(parseUrls("https://a.example/1?utm_source=x\nhttps://a.example/1\nnot a url\nftp://x\n https://b.example/2 ")).toEqual(["https://a.example/1", "https://b.example/2"]);
  });
});

describe("scrape jobs", () => {
  const site = (failing: { on: boolean }) => vi.fn(async (url: string) => {
    if (url.endsWith("/sitemap.xml")) {
      return new Response(`<urlset><url><loc>https://shop.example/p/1</loc></url><url><loc>https://shop.example/p/2</loc></url></urlset>`, { headers: { "content-type": "application/xml" } });
    }
    if (url.endsWith("/p/2") && failing.on) return new Response("down", { status: 503, headers: { "content-type": "text/html" } });
    const n = Number(url.split("/").pop());
    return new Response(productPage(`Item ${n}`, n * 10), { headers: { "content-type": "text/html" } });
  });

  it("expands a sitemap, extracts every page, and a re-run only retries the failures", async () => {
    const db = await testDb();
    const failing = { on: true };
    const fetchMock = site(failing);
    vi.stubGlobal("fetch", fetchMock);
    const [job] = await db.insert(scrapeJobs).values({ name: "Ціни", urls: ["https://shop.example/sitemap.xml", "https://shop.example/p/3"], total: 2 }).returning();
    expect(await runNextScrapeJob(db)).toBe(true);
    let [j] = await db.select().from(scrapeJobs).where(eq(scrapeJobs.id, job.id));
    expect([j.status, j.total, j.done, j.failed]).toEqual(["done", 3, 2, 1]);
    const rows = await db.select().from(scrapeResults).orderBy(scrapeResults.url);
    expect(rows.map((r) => [r.url.slice(-3), r.data.price ?? null, r.error])).toEqual([["p/1", 10, null], ["p/2", null, "HTTP 503"], ["p/3", 30, null]]);

    failing.on = false;
    const before = fetchMock.mock.calls.length;
    await db.update(scrapeJobs).set({ status: "running" }).where(eq(scrapeJobs.id, job.id)); // сервер перезапустили
    await requeueInterruptedJobs(db);
    await runNextScrapeJob(db);
    [j] = await db.select().from(scrapeJobs).where(eq(scrapeJobs.id, job.id));
    expect([j.status, j.done, j.failed]).toEqual(["done", 3, 0]);
    expect(fetchMock.mock.calls.length - before).toBe(1); // лише сторінка, що не вдалася
  });

  it("extracts fields with the language model when asked, falling back to Firecrawl text", async () => {
    const db = await testDb();
    await addTestKey(db, "groq", "gq");
    await addTestKey(db, "firecrawl", "fc");
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
      if (url.includes("/chat/completions")) {
        expect(JSON.parse(init.body).messages[0].content).toContain("Blocked page text with price 49");
        return Response.json({ choices: [{ message: { content: '{"ціна": 49, "назва": "Lamp", "наявність": null}' } }] });
      }
      if (url.includes("firecrawl.dev")) return Response.json({ success: true, data: { markdown: "Blocked page text with price 49", metadata: {} } });
      return new Response("no", { status: 403, headers: { "content-type": "text/html" } });
    }));
    await db.insert(scrapeJobs).values({ name: "AI", urls: ["https://guarded.example/x"], mode: "ai", fields: [{ name: "ціна" }, { name: "назва" }, { name: "наявність" }], allowPaid: true });
    await runNextScrapeJob(db);
    const [row] = await db.select().from(scrapeResults);
    expect([row.data, row.via, row.error]).toEqual([{ ціна: 49, назва: "Lamp", наявність: null }, "firecrawl", null]);
  });
});
