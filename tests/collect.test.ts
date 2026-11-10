import { afterEach, describe, expect, it, vi } from "vitest";
import { ContentItemSchema } from "@/core/contract";
import { collect, saveItems } from "@/collect";
import { mapFirecrawl } from "@/collect/firecrawl";
import { mapPost, mapProfile } from "@/collect/instagram";
import { extractHtml } from "@/collect/local";
import { contentItems, usageEvents } from "@/db/schema";
import { addTestKey, testDb } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const html = (body: string, head = "") => `<html lang="uk"><head><title>Назва</title>${head}</head><body>${body}</body></html>`;
const longText = "Справжній вміст статті. ".repeat(30);
const page = (text: string, init: ResponseInit = {}) =>
  new Response(text, { headers: { "content-type": "text/html; charset=utf-8" }, ...init });

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

  it("explains when the page is blocked and no Firecrawl key is available", async () => {
    const db = await testDb();
    vi.stubGlobal("fetch", vi.fn(async () => page("no", { status: 403 })));
    await expect(collect(db, { type: "url", url: "https://guarded.example/" })).rejects.toThrow(/HTTP 403.*Firecrawl немає/);
  });

  it("routes an Instagram profile URL to Apify and upserts on repeat", async () => {
    const db = await testDb();
    await addTestKey(db, "apify", "ap");
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      calls.push(url);
      if (url.includes("/users/me/limits")) return Response.json({ data: { limits: { maxMonthlyUsageUsd: 5 }, current: { monthlyUsageUsd: 0.01 } } });
      expect(JSON.parse(init.body)).toEqual({ usernames: ["maker"] });
      return Response.json([{ username: "maker", followersCount: 10, latestPosts: [{ shortCode: "P1", url: "https://www.instagram.com/p/P1/", type: "Image", displayUrl: "https://cdn.example/1.jpg" }] }]);
    }));
    const r = await collect(db, { type: "url", url: "https://www.instagram.com/maker/" });
    expect(r.items.map((i) => i.id)).toEqual(["profile:maker", "P1"]);
    expect(calls[0]).toContain("instagram-profile-scraper");
    await collect(db, { type: "instagram-profile", username: "@maker" });
    expect(await db.select().from(contentItems)).toHaveLength(2);
  });

  it("rejects items that break the contract", async () => {
    const db = await testDb();
    await expect(saveItems(db, [{ id: "", source: "web", kind: "article", url: "https://a.example", fetchedAt: new Date(), via: "local" }])).rejects.toThrow();
  });
});
