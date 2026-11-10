import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetScraplingCache } from "@/collect/scrapling";
import { ContentItemSchema } from "@/core/contract";
import { eq } from "drizzle-orm";
import { AlreadyRunningError, collect, saveItems } from "@/collect";
import { assertPublicUrl, isPrivateAddress, UnsafeUrlError } from "@/collect/net";
import { mapFirecrawl } from "@/collect/firecrawl";
import { mapPost, mapProfile, runCostUsd } from "@/collect/instagram";
import { extractHtml } from "@/collect/local";
import { collectRuns, contentItems, usageEvents } from "@/db/schema";
import { addTestKey, testDb } from "./helpers";

// Підроблений scrapling: поведінку задає змінна FAKE_SCRAPLING (http=...;stealth=...).
const fakeDir = mkdtempSync(path.join(os.tmpdir(), "fake-scrapling-"));
const fakeBin = path.join(fakeDir, "scrapling");
writeFileSync(fakeBin, `#!/usr/bin/env node
const fs = require("fs");
const [, , a, mode, url, out] = process.argv;
if (a === "--help") process.exit(0);
const plan = Object.fromEntries((process.env.FAKE_SCRAPLING || "").split(";").map((p) => p.split("=")));
const what = plan[mode === "get" ? "http" : "stealth"] || "ok";
const body = "Справжній вміст статті. ".repeat(30);
if (what === "ok") { fs.writeFileSync(out, "<html><head><title>Via " + mode + "</title></head><body><main>" + body + "</main></body></html>"); console.log("INFO: Fetched (200) <GET " + url + ">"); }
else if (what === "challenge") { fs.writeFileSync(out, "<html><body><h1>Just a moment...</h1></body></html>"); console.log("INFO: Fetched (403) <GET " + url + ">"); }
else process.exit(1);
`);
chmodSync(fakeBin, 0o755);

beforeEach(() => {
  process.env.SCRAPLING_BIN = path.join(fakeDir, "missing"); // за замовчуванням Scrapling «не встановлено»
  resetScraplingCache();
});
afterEach(() => vi.unstubAllGlobals());

const html = (body: string, head = "") => `<html lang="uk"><head><title>Назва</title>${head}</head><body>${body}</body></html>`;
const longText = "Справжній вміст статті. ".repeat(30);
const page = (text: string, init: ResponseInit = {}) =>
  new Response(text, { headers: { "content-type": "text/html; charset=utf-8" }, ...init });

/** Підробка асинхронного API Apify: створення запуску, його стан із вартістю, набір даних, звірка лімітів. */
const apifyMock = (items: unknown[]) =>
  vi.fn(async (url: string, _init?: any) => {
    if (url.includes("/users/me/limits")) return Response.json({ data: { limits: { maxMonthlyUsageUsd: 5 }, current: { monthlyUsageUsd: 0.02 } } });
    if (url.endsWith("/runs")) return Response.json({ data: { id: "run1", status: "RUNNING", defaultDatasetId: "ds1" } }, { status: 201 });
    if (url.includes("/actor-runs/run1")) return Response.json({ data: { id: "run1", status: "SUCCEEDED", defaultDatasetId: "ds1", usageTotalUsd: 0.0123 } });
    if (url.includes("/datasets/ds1/items")) return Response.json(items);
    throw new Error(`unexpected ${url}`);
  });

describe("local extraction", () => {
  it("pulls title, text, author, image and date; drops chrome", () => {
    const item = ContentItemSchema.parse(extractHtml(
      html(`<nav>Меню</nav><article><p>${longText}</p></article><footer>Підвал</footer><script>x()</script>`,
        `<meta property="og:title" content="OG назва"><meta property="og:image" content="/img/a.jpg">
         <meta name="author" content="Олена"><meta property="article:published_time" content="2026-10-01T08:00:00Z">`),
      "https://blog.example/post",
    ));
    expect(item.title).toBe("OG назва");
    expect(item.text).toContain("Справжній вміст");
    expect(item.text).not.toMatch(/Меню|Підвал|x\(\)/);
    expect(item.author?.displayName).toBe("Олена");
    expect(item.media[0].url).toBe("https://blog.example/img/a.jpg");
    expect(item.publishedAt?.toISOString()).toBe("2026-10-01T08:00:00.000Z");
    expect(item.lang).toBe("uk");
  });
});

describe("instagram mapping", () => {
  const post = {
    id: "1", type: "Video", shortCode: "ABC", caption: "unboxing #ugc", hashtags: ["ugc"], url: "https://www.instagram.com/p/ABC/",
    commentsCount: 4, likesCount: -1, videoPlayCount: 900, videoUrl: "https://cdn.example/v.mp4", displayUrl: "https://cdn.example/c.jpg",
    dimensionsWidth: 720, dimensionsHeight: 1280, timestamp: "2026-11-09T19:59:20.000Z", ownerUsername: "maker", ownerId: "77",
  };
  it("maps a video post and hides the -1 like counter", () => {
    const item = ContentItemSchema.parse(mapPost(post));
    expect(item).toMatchObject({ id: "ABC", kind: "video", tags: ["ugc"], metrics: { comments: 4, views: 900 } });
    expect(item.metrics.likes).toBeUndefined();
    expect(item.media[0]).toMatchObject({ type: "video", thumbnailUrl: "https://cdn.example/c.jpg" });
    expect(item.author).toMatchObject({ username: "maker", url: "https://www.instagram.com/maker/" });
  });
  it("maps a carousel to all its images", () => {
    const item = mapPost({ ...post, type: "Sidecar", images: ["https://cdn.example/1.jpg", "https://cdn.example/2.jpg"] })!;
    expect(item.kind).toBe("post");
    expect(item.media).toHaveLength(2);
  });
  it("maps a profile with deduplicated bio links plus its posts", () => {
    const items = mapProfile({
      id: "77", username: "maker", fullName: "Maker", biography: "UGC creator · collab", followersCount: 5400, verified: false,
      externalUrl: "https://beacons.ai/maker", externalUrls: [{ url: "https://beacons.ai/maker" }, { url: "https://stan.store/maker" }],
      profilePicUrlHD: "https://cdn.example/a.jpg", latestPosts: [{ ...post, ownerUsername: undefined }, { shortCode: null }],
    }).map((i) => ContentItemSchema.parse(i));
    expect(items.map((i) => i.kind)).toEqual(["profile", "video"]);
    expect(items[0].author?.links).toEqual(["https://beacons.ai/maker", "https://stan.store/maker"]);
    expect(items[1].author?.username).toBe("maker");
  });
});

describe("apify run cost", () => {
  const pricingInfo = { pricingPerEvent: { actorChargeEvents: { result: { isPrimaryEvent: true, eventPriceUsd: 0.0026 }, extra: { eventPriceUsd: 0.007 } } } };
  it("uses the larger of Apify's total, charged events and a per-result estimate", () => {
    expect(runCostUsd({ usageTotalUsd: 0.013, pricingInfo, chargedEventCounts: { result: 5 } }, 5)).toBe(0.013);
    expect(runCostUsd({ usageTotalUsd: 0, pricingInfo, chargedEventCounts: { result: 5, extra: 1 } }, 5)).toBe(0.02);
    expect(runCostUsd({ pricingInfo, chargedEventCounts: {} }, 3)).toBe(0.0078);
    expect(runCostUsd({}, 3)).toBe(0);
  });
});

describe("firecrawl mapping", () => {
  it("maps markdown and metadata", () => {
    const item = ContentItemSchema.parse(mapFirecrawl(
      { markdown: "# Hi", metadata: { title: "T", language: "en", ogImage: "https://x.example/i.png" } }, "https://x.example/"));
    expect(item).toMatchObject({ via: "firecrawl", title: "T", text: "# Hi", lang: "en" });
    expect(item.media).toHaveLength(1);
  });
});

describe("cascade", () => {
  it("serves an open page locally without spending a Firecrawl credit, then from cache", async () => {
    const db = await testDb();
    await addTestKey(db, "firecrawl", "fc");
    const fetchMock = vi.fn(async () => page(html(`<main>${longText}</main>`)));
    vi.stubGlobal("fetch", fetchMock);
    const first = await collect(db, { type: "url", url: "https://open.example/a" });
    expect(first.items[0].via).toBe("local");
    const second = await collect(db, { type: "url", url: "https://open.example/a" });
    expect(second.cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await db.select().from(usageEvents)).toHaveLength(0);
  });

  it("falls back to Firecrawl on a bot-protection page and records the credit", async () => {
    const db = await testDb();
    await addTestKey(db, "firecrawl", "fc");
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.includes("firecrawl.dev")
        ? Response.json({ success: true, data: { markdown: "real content", metadata: { title: "Protected", creditsUsed: 1 } } })
        : page(html("<h1>Just a moment...</h1>"), { status: 403 })));
    const r = await collect(db, { type: "url", url: "https://guarded.example/" });
    expect(r.items[0]).toMatchObject({ via: "firecrawl", text: "real content" });
    expect(r.notes[0]).toContain("Firecrawl");
    expect((await db.select().from(usageEvents))[0]).toMatchObject({ ok: true, units: 1, purpose: "scrape" });
  });

  const useFake = (plan: string) => {
    process.env.SCRAPLING_BIN = fakeBin;
    process.env.FAKE_SCRAPLING = plan;
    resetScraplingCache();
  };
  const blocked = () => vi.fn(async (url: string) => {
    if (url.includes("firecrawl.dev")) throw new Error("Firecrawl must not be called");
    return page("no", { status: 403 });
  });

  it("uses Scrapling when the direct request is blocked, without touching Firecrawl", async () => {
    const db = await testDb();
    await addTestKey(db, "firecrawl", "fc");
    useFake("http=ok");
    vi.stubGlobal("fetch", blocked());
    const r = await collect(db, { type: "url", url: "https://guarded.example/a" });
    expect(r.items[0]).toMatchObject({ via: "scrapling", title: "Via get" });
    expect(r.notes[0]).toMatch(/Прямий запит: HTTP 403 — спрацював Scrapling$/);
    expect(await db.select().from(usageEvents)).toHaveLength(0);
  });

  it("escalates to the stealth browser when Scrapling's HTTP mode hits a challenge", async () => {
    const db = await testDb();
    useFake("http=challenge;stealth=ok");
    vi.stubGlobal("fetch", blocked());
    const r = await collect(db, { type: "url", url: "https://guarded.example/b" });
    expect(r.items[0]).toMatchObject({ via: "scrapling-stealth", title: "Via fetch" });
    expect(r.notes[0]).toContain("Scrapling: HTTP 403");
  });

  it("falls through to Firecrawl when both Scrapling modes fail", async () => {
    const db = await testDb();
    await addTestKey(db, "firecrawl", "fc");
    useFake("http=challenge;stealth=crash");
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.includes("firecrawl.dev")
        ? Response.json({ success: true, data: { markdown: "from firecrawl", metadata: {} } })
        : page("no", { status: 403 })));
    const r = await collect(db, { type: "url", url: "https://guarded.example/c" });
    expect(r.items[0].via).toBe("firecrawl");
    expect(r.notes[0]).toContain("Scrapling (браузер)");
  });

  it("explains when the page is blocked and no Firecrawl key is available", async () => {
    const db = await testDb();
    vi.stubGlobal("fetch", vi.fn(async () => page("no", { status: 403 })));
    await expect(collect(db, { type: "url", url: "https://guarded.example/" })).rejects.toThrow(/HTTP 403.*Firecrawl немає/s);
  });

  it("routes an Instagram profile URL to Apify, records the run's real cost, caches and upserts", async () => {
    const db = await testDb();
    await addTestKey(db, "apify", "ap");
    const fetchMock = apifyMock([{ username: "maker", followersCount: 10, latestPosts: [{ shortCode: "P1", url: "https://www.instagram.com/p/P1/", type: "Image", displayUrl: "https://cdn.example/1.jpg" }] }]);
    vi.stubGlobal("fetch", fetchMock);
    const r = await collect(db, { type: "url", url: "https://www.instagram.com/maker/" });
    expect(r.items.map((i) => i.id)).toEqual(["profile:maker", "P1"]);
    expect(r.ids).toHaveLength(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ usernames: ["maker"] });
    expect(fetchMock.mock.calls[0][0]).toContain("instagram-profile-scraper/runs");
    expect((await db.select().from(usageEvents))[0]).toMatchObject({ ok: true, units: 0.0123, purpose: "instagram-profile" });
    const [profileRow] = await db.select().from(contentItems).where(eq(contentItems.externalId, "profile:maker"));
    expect((profileRow.raw as any).followersCount).toBe(10);

    const runs = fetchMock.mock.calls.length;
    const again = await collect(db, { type: "instagram-profile", username: "@Maker" });
    expect(again.cached).toBe(true);
    expect(fetchMock.mock.calls.length).toBe(runs);
    await collect(db, { type: "instagram-profile", username: "maker" }, { fresh: true });
    expect(await db.select().from(contentItems)).toHaveLength(2);
  });

  it("fails loudly when the actor's format changes instead of reporting an empty result", async () => {
    const db = await testDb();
    await addTestKey(db, "apify", "ap");
    vi.stubGlobal("fetch", apifyMock([{ code: "X1", link: "https://www.instagram.com/p/X1/" }]));
    await expect(collect(db, { type: "instagram-hashtag", tag: "ugc", limit: 5 })).rejects.toThrow(/змінив формат.*X1/s);
    const [run] = await db.select().from(collectRuns);
    expect(run.status).toBe("failed");
  });

  it("refuses to start the same collection twice", async () => {
    const db = await testDb();
    await db.insert(collectRuns).values({ targetKey: "ig-profile:maker" });
    await expect(collect(db, { type: "instagram-profile", username: "maker" })).rejects.toBeInstanceOf(AlreadyRunningError);
    // покинутий запуск (старший за 20 хв) не блокує назавжди
    await db.update(collectRuns).set({ startedAt: new Date(Date.now() - 30 * 60_000) });
    await addTestKey(db, "apify", "ap");
    vi.stubGlobal("fetch", apifyMock([{ username: "maker" }]));
    expect((await collect(db, { type: "instagram-profile", username: "maker" })).items).toHaveLength(1);
  });

  it("does not spend a Firecrawl credit on a page that does not exist", async () => {
    const db = await testDb();
    await addTestKey(db, "firecrawl", "fc");
    const fetchMock = vi.fn(async () => page("gone", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(collect(db, { type: "url", url: "https://open.example/typo" })).rejects.toThrow(/HTTP 404/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await db.select().from(usageEvents)).toHaveLength(0);
  });

  it("treats tracking parameters and fragments as the same page", async () => {
    const db = await testDb();
    const fetchMock = vi.fn(async () => page(html(`<main>${longText}</main>`)));
    vi.stubGlobal("fetch", fetchMock);
    await collect(db, { type: "url", url: "https://open.example/a?id=1" });
    const again = await collect(db, { type: "url", url: "https://OPEN.example/a?utm_source=tg&id=1&fbclid=x#top" });
    expect(again.cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await db.select().from(contentItems)).toHaveLength(1);
  });

  it("retries Firecrawl on another key after a 502 and does not charge an unbilled failure", async () => {
    const db = await testDb();
    await addTestKey(db, "firecrawl", "A");
    await addTestKey(db, "firecrawl", "B");
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (!url.includes("firecrawl.dev")) return page("no", { status: 403 });
      return ++n === 1 ? new Response("bad gateway", { status: 502 }) : Response.json({ success: true, data: { markdown: "ok", metadata: {} } });
    }));
    expect((await collect(db, { type: "url", url: "https://guarded.example/r" })).items[0].via).toBe("firecrawl");
    const events = await db.select().from(usageEvents).orderBy(usageEvents.id);
    expect(events.map((e) => [e.ok, e.units])).toEqual([[false, 0], [true, 1]]);

    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.includes("firecrawl.dev") ? Response.json({ success: false, error: "unsupported site" }) : page("no", { status: 403 })));
    await expect(collect(db, { type: "url", url: "https://guarded.example/s" })).rejects.toThrow(/unsupported site/);
    expect((await db.select().from(usageEvents).orderBy(usageEvents.id)).at(-1)).toMatchObject({ ok: false, units: 0 });
  });

  it("saves the good items of a batch, skipping a broken one and a duplicate", async () => {
    const db = await testDb();
    const base = { source: "instagram" as const, kind: "post" as const, fetchedAt: new Date(), via: "apify" as const };
    const r = await saveItems(db, [
      { ...base, id: "A", url: "https://www.instagram.com/p/A/" },
      { ...base, id: "B", url: "not a url" },
      { ...base, id: "A", url: "https://www.instagram.com/p/A/" },
      { ...base, id: "C", url: "https://www.instagram.com/p/C/", media: [{ type: "image", url: "javascript:alert(1)" }] },
      { ...base, id: "D", url: "https://www.instagram.com/p/D/" },
    ]);
    expect(r.items.map((i) => i.id)).toEqual(["A", "D"]);
    expect(r.ids).toHaveLength(2);
    expect(r.skipped).toHaveLength(2);
    expect(r.skipped[0]).toContain("B: url");
    expect(await db.select().from(contentItems)).toHaveLength(2);
  });
});

describe("network guard", () => {
  it("recognises private and special addresses", () => {
    for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.5.4", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("rejects internal targets, credentials and non-http schemes", async () => {
    const pub = async () => ["93.184.216.34"];
    for (const u of ["http://127.0.0.1:3000/", "http://[::1]/", "http://10.0.0.1/", "http://localhost/", "http://router.local/", "file:///etc/passwd", "https://user:pw@site.example/"]) {
      await expect(assertPublicUrl(u, pub), u).rejects.toBeInstanceOf(UnsafeUrlError);
    }
    await expect(assertPublicUrl("https://site.example/", async () => ["10.1.2.3"])).rejects.toThrow(/внутрішню мережу/);
    await expect(assertPublicUrl("https://site.example/", pub)).resolves.toBeInstanceOf(URL);
  });

  it("blocks a public page that redirects to an internal address, without falling back to paid tiers", async () => {
    const db = await testDb();
    await addTestKey(db, "firecrawl", "fc");
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(collect(db, { type: "url", url: "https://open.example/redirect" })).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(collect(db, { type: "url", url: "http://192.168.1.1/admin" })).rejects.toBeInstanceOf(UnsafeUrlError);
  });
});

describe("page decoding", () => {
  it("keeps paragraph boundaries", () => {
    const item = extractHtml(html("<article><h1>Заголовок</h1><p>Перший абзац.</p><p>Другий<br>рядок.</p><ul><li>Пункт</li></ul></article>"), "https://b.example/");
    expect(item.text).toBe("Заголовок\n\nПерший абзац.\n\nДругий\nрядок.\n\nПункт");
  });

  it("decodes windows-1251 pages", async () => {
    const db = await testDb();
    const body = `<html><head><meta charset="windows-1251"><title>Тест</title></head><body><main>${"Привіт, це кирилиця. ".repeat(20)}</main></body></html>`;
    const bytes = new Uint8Array([...body].map((ch) => {
      const c = ch.charCodeAt(0);
      if (c < 128) return c;
      if (c >= 0x410 && c <= 0x44f) return c - 0x350;
      return ({ 0x456: 0xb3, 0x406: 0xb2 } as Record<number, number>)[c] ?? 63;
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes, { headers: { "content-type": "text/html" } })));
    const r = await collect(db, { type: "url", url: "https://cp1251.example/" });
    expect(r.items[0].title).toBe("Тест");
    expect(r.items[0].text).toContain("Привіт, це кирилиця.");
  });

  it("does not mistake an article that mentions 'Access Denied' for a bot wall", async () => {
    const db = await testDb();
    vi.stubGlobal("fetch", vi.fn(async () => page(html(`<main><p>How to fix Access Denied errors.</p><p>${"Long explanation. ".repeat(120)}</p></main>`))));
    expect((await collect(db, { type: "url", url: "https://blog.example/access-denied" })).items[0].via).toBe("local");
  });
});

describe("contract urls", () => {
  it("rejects javascript: and file: links", () => {
    const base = { id: "1", source: "web", kind: "article", fetchedAt: new Date(), via: "local" };
    expect(() => ContentItemSchema.parse({ ...base, url: "javascript:alert(1)" })).toThrow();
    expect(() => ContentItemSchema.parse({ ...base, url: "https://a.example", author: { links: ["file:///etc/passwd"] } })).toThrow();
    expect(() => ContentItemSchema.parse({ ...base, url: "https://a.example", author: { links: ["https://beacons.ai/x"] } })).not.toThrow();
  });
});
