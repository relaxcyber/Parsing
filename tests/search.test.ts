import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { collagePath, qualityIndex, VisionAuditSchema } from "@/audit/vision";
import { contentItems, creatorContacts, creators, searchCandidates, searches, suppressions, usageEvents } from "@/db/schema";
import { activityOf } from "@/enrich/activity";
import { checkEmail } from "@/enrich/email";
import { extractLinkPage } from "@/enrich/linkpage";
import { classifyLinks } from "@/enrich/links";
import { parseJsonReply } from "@/llm/client";
import { toCsv } from "@/search/csv";
import { estimateCostUsd, requeueInterrupted, runNextSearch } from "@/search/pipeline";
import { extractEmails, overall, readinessIndex, scoreCandidate } from "@/search/signals";
import { suppressCreator } from "@/search/suppress";
import { addTestKey, testDb } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

describe("fit index", () => {
  const base = { keywords: ["skincare", "makeup"], stopWords: [] as string[] };
  it("combines niche match (up to 60) with the creator role (up to 40)", () => {
    const s = scoreCandidate({ ...base, texts: ["New unboxing! #ugccreator #skincare"], ignoreTags: ["ugccreator"], bio: "UGC creator | collabs welcome" });
    expect(s.fit).toBe(78); // роль 16+8+8+4=36, ніша 60·√1/√2≈42
    expect(s.reasons).toEqual(expect.arrayContaining(["називає себе UGC-креатором", "відкритий до співпраці", "ніша: skincare"]));
    expect([s.blocked, s.negative]).toEqual([false, false]);
  });
  it("penalises shops, blocks stop words, and ignores the search's own hashtag", () => {
    const shop = scoreCandidate({ ...base, texts: ["Shop now, free shipping! #ugc"] });
    expect(shop.negative).toBe(true);
    expect(shop.reasons).toContain("мінус: схоже на магазин");
    expect(scoreCandidate({ keywords: [], stopWords: ["giveaway"], texts: ["ugc creator, giveaway inside"] }).blocked).toBe(true);
    expect(scoreCandidate({ keywords: [], stopWords: [], texts: ["sunset #ugccreator"], ignoreTags: ["ugccreator"] }).fit).toBe(0);
  });
  it("flags creator marketplaces as not an individual author", () => {
    const s = scoreCandidate({ keywords: [], stopWords: [], texts: [], bio: "Real influencers. Brands × verified UGC creators. Start free" });
    expect(s.negative).toBe(true);
  });
  it("treats agency-like account names and communities as not an individual", () => {
    const agency = scoreCandidate({ keywords: [], stopWords: [], texts: ["ugc creator"], bio: "Full-Service Talent Management. Join Us", names: ["celestetalentagency", "Celeste Talent Agency"] });
    expect(agency.negative).toBe(true);
    expect(scoreCandidate({ keywords: [], stopWords: [], texts: [], bio: "Comunidad de Creadores", names: ["influ"] }).negative).toBe(true);
    expect(scoreCandidate({ keywords: [], stopWords: [], texts: ["ugc creator"], names: ["anna.creates", "Anna"] }).negative).toBe(false);
  });
  it("matches Cyrillic niche words and whole words only", () => {
    expect(scoreCandidate({ keywords: ["догляд"], stopWords: [], texts: ["Мій догляд за шкірою"] }).fit).toBe(60);
    expect(scoreCandidate({ keywords: ["art"], stopWords: [], texts: ["a smart start"] }).fit).toBe(0);
  });
  it("in affiliate focus, storefronts and codes outweigh UGC wording", () => {
    const input = { keywords: [], stopWords: [], texts: ["Amazon finds! use my code ANNA10, link in bio"], affiliate: ["Amazon Storefront", "LTK"] };
    const aff = scoreCandidate({ ...input, focus: "affiliate" });
    const ugc = scoreCandidate({ ...input, focus: "ugc" });
    expect(aff.fit).toBe(100);
    expect(ugc.fit).toBeLessThan(40);
    expect(aff.reasons).toEqual(expect.arrayContaining(["веде партнерську вітрину", "роздає промокоди", "партнерки: Amazon Storefront, LTK"]));
  });
});

describe("readiness index", () => {
  it("follows the spec weights: contact 40, freshness 30/15, rate card 20, portfolio 10", () => {
    expect(readinessIndex({ emailStatus: "personal", daysSincePost: 3, hasRate: true, hasPortfolio: true }).readiness).toBe(100);
    expect(readinessIndex({ emailStatus: "role", daysSincePost: 10 }).readiness).toBe(35);
    expect(readinessIndex({ daysSincePost: 20 }).readiness).toBe(0);
    expect(overall(80, 40, null)).toBe(60);
    expect(overall(80, 40, 60)).toBe(60);
  });
});

describe("activity", () => {
  const now = new Date("2026-11-10T12:00:00Z");
  const post = (daysAgo: number, views?: number) => ({ publishedAt: new Date(now.getTime() - daysAgo * 86_400_000), metrics: { views } });
  it("classifies active / dormant / ghost by the last post", () => {
    expect(activityOf([post(40), post(3)], 1000, now)).toMatchObject({ status: "active", daysSincePost: 3 });
    expect(activityOf([post(20)], 1000, now).status).toBe("dormant");
    expect(activityOf([post(31)], 1000, now).status).toBe("ghost");
    expect(activityOf([], 1000, now).status).toBe("unknown");
  });
  it("computes views ER from the median of recent videos", () => {
    const a = activityOf([post(1, 100), post(2, 300), post(3, 200), post(4)], 1000, now);
    expect([a.medianViews, a.erViews]).toEqual([200, 0.2]);
  });
});

describe("email check", () => {
  const mx = (map: Record<string, string | Error>) => async (domain: string) => {
    const v = map[domain];
    if (v instanceof Error) throw v;
    return v ? [{ exchange: v, priority: 10 }] : [];
  };
  it("classifies personal, business, role, disposable and dead addresses", async () => {
    expect(await checkEmail("Anna.UGC@Gmail.com")).toMatchObject({ email: "anna.ugc@gmail.com", status: "personal", mx: "freemail" });
    expect((await checkEmail("anna@annacreates.co", mx({ "annacreates.co": "mx.zoho.com" }))).status).toBe("business");
    expect((await checkEmail("info@brand.com", mx({ "brand.com": "mx.brand.com" }))).status).toBe("role");
    expect((await checkEmail("x@mailinator.com")).status).toBe("disposable");
    expect((await checkEmail("a@nomail.example", mx({}))).status).toBe("no_mx");
    expect((await checkEmail("a@gone.example", mx({ "gone.example": Object.assign(new Error("nx"), { code: "ENOTFOUND" }) }))).status).toBe("no_mx");
    expect((await checkEmail("a@flaky.example", mx({ "flaky.example": Object.assign(new Error("t"), { code: "ETIMEOUT" }) }))).status).toBe("unknown");
    expect((await checkEmail("not an email")).status).toBe("invalid");
  });
});

describe("link pages", () => {
  it("reads a Next.js Pages Router page (__NEXT_DATA__)", () => {
    const data = { props: { pageProps: {
      socialLinks: [{ type: "EMAIL_ADDRESS", url: "mailto:anna.ugc@gmail.com" }, { type: "TIKTOK", url: "https://tiktok.com/@anna.ugc" }],
      links: [{ title: "My UGC portfolio", url: "https://anna.my.canva.site/portfolio" }, { title: "Amazon", url: "https://www.amazon.com/shop/anna" }],
    } } };
    const html = `<html><head><title>@anna | Linktree</title></head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`;
    const d = extractLinkPage(html, "https://linktr.ee/anna");
    expect(d.format).toBe("next-data");
    expect(d.emails).toEqual([{ email: "anna.ugc@gmail.com", via: "mailto" }]);
    expect(d.portfolio).toEqual(["https://anna.my.canva.site/portfolio"]);
    expect(d.affiliate).toEqual(["Amazon Storefront"]);
    expect(d.socials).toEqual({ tiktok: "anna.ugc" });
  });

  it("reads an App Router page (RSC stream) with escaped quotes, and tells UGC rates from digital products", () => {
    const chunk = JSON.stringify(`a:["$","a",null,{"href":"https://shopmy.us/shop/anna","children":"Shop \\"my\\" faves"}]\nb:{"email":"hello@annacreates.co"}`);
    const html = `<html><head><title>Anna | Stan</title></head><body>
      <a href="https://www.shopltk.com/explore/anna">LTK</a>
      <div>1 UGC video with usage rights <span>$150</span></div>
      <div>My content creator ebook guide <span>$9.99</span></div>
      <script>self.__next_f.push([1,${chunk}])</script>
      <a href="mailto:support@stan.store">help</a></body></html>`;
    const d = extractLinkPage(html, "https://stan.store/anna");
    expect(d.format).toBe("rsc");
    expect(d.emails.map((e) => e.email)).toEqual(["hello@annacreates.co"]);
    expect(d.affiliate).toEqual(["LTK", "ShopMy"]);
    expect(d.offers.map((o) => [o.amount, o.ugcRate])).toEqual([[150, true], [9.99, false]]);
  });

  it("classifies profile links", () => {
    const c = classifyLinks(["https://beacons.ai/anna", "https://amzn.to/abc", "https://www.instagram.com/p/XYZ/", "https://www.youtube.com/@anna"]);
    expect(c).toEqual({ hubs: ["https://beacons.ai/anna"], portfolio: [], affiliate: ["Amazon"], socials: { youtube: "@anna" } });
  });
});

describe("vision audit helpers", () => {
  const audit = VisionAuditSchema.parse({
    production_tier: "FLAGSHIP_SMARTPHONE", production_confidence: 0.8, lighting_quality: 8, background_cleanliness: 7,
    direct_response_signals: { has_captions_subtitles: true, clear_product_focus: true, engaging_expression: false },
  });
  it("derives the quality index and defaults optional fields", () => {
    expect(qualityIndex(audit)).toBe(76); // 80·0.4 + 80·0.25 + 70·0.25 + 66.7·0.1
    expect(audit).toMatchObject({ minor_is_main_subject: false, brand_safety_flags: [], rejection_reasons: [] });
    expect(qualityIndex({ ...audit, production_tier: "LOWEND_DEGRADED", lighting_quality: 3, background_cleanliness: 3 })).toBe(32);
  });
  it("pulls JSON out of a chatty model reply", () => {
    expect(parseJsonReply('Sure!\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(() => parseJsonReply("no json here")).toThrow();
  });
});

describe("csv", () => {
  it("quotes cells and neutralises spreadsheet formulas", () => {
    expect(toCsv(["a", "b"], [["=SUM(1)", 'say "hi", ok'], ["-5", -5]])).toBe('﻿a,b\r\n\'=SUM(1),"say ""hi"", ok"\r\n\'-5,-5\r\n');
    expect(extractEmails("Collabs 📩 Hello.Me@Mail.co.uk. or pic@2x.png")).toEqual(["hello.me@mail.co.uk"]);
  });
});

const NOW = Date.now();
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

/** Підробка зовнішнього світу: Apify (хештеги й профілі), сторінки-візитки, картинки та мовна модель. */
async function world(posts: any[], profiles: Record<string, any>, opts: { pages?: Record<string, string>; llm?: unknown } = {}) {
  const runs = new Map<string, any[]>();
  const calls = { hashtag: 0, profile: 0, profileInputs: [] as string[][], pages: [] as string[], llm: 0 };
  const jpeg = await sharp({ create: { width: 320, height: 320, channels: 3, background: "#c08", noise: { type: "gaussian", mean: 128, sigma: 40 } } }).jpeg().toBuffer();
  const mock = vi.fn(async (url: string, init?: any) => {
    if (url.includes("/users/me/limits")) return Response.json({ data: { limits: { maxMonthlyUsageUsd: 5 }, current: { monthlyUsageUsd: 0.1 } } });
    if (url.includes("/runs?")) {
      const id = `run${runs.size + 1}`;
      const input = JSON.parse(init.body);
      if (url.includes("hashtag-scraper")) {
        calls.hashtag++;
        runs.set(id, posts.filter((p) => p.tag === input.hashtags[0]));
      } else {
        calls.profile++;
        calls.profileInputs.push(input.usernames);
        runs.set(id, input.usernames.map((u: string) => profiles[u] ?? { error: "not_found", username: u }));
      }
      return Response.json({ data: { id, status: "RUNNING", defaultDatasetId: id } });
    }
    const run = url.match(/actor-runs\/(run\d+)/)?.[1];
    if (run) return Response.json({ data: { id: run, status: "SUCCEEDED", defaultDatasetId: run, usageTotalUsd: 0.01 } });
    const ds = url.match(/datasets\/(run\d+)\/items/)?.[1];
    if (ds) return Response.json(runs.get(ds));
    if (url.includes("/chat/completions")) {
      calls.llm++;
      if (!opts.llm) return new Response("rate limited", { status: 429, headers: { "retry-after": "3600" } });
      return Response.json({ choices: [{ message: { content: JSON.stringify(opts.llm) } }] });
    }
    if (url.startsWith("https://cdn.example/")) return new Response(new Uint8Array(jpeg), { headers: { "content-type": "image/jpeg" } });
    if (opts.pages?.[url]) {
      calls.pages.push(url);
      return new Response(opts.pages[url], { headers: { "content-type": "text/html" } });
    }
    return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
  });
  return { mock, calls };
}

const post = (code: string, owner: string, caption: string, tag = "ugccreator") => ({
  tag, shortCode: code, url: `https://www.instagram.com/p/${code}/`, type: "Image", caption, hashtags: [tag],
  ownerUsername: owner, ownerId: `id-${owner}`, ownerFullName: owner.toUpperCase(), displayUrl: `https://cdn.example/${code}.jpg`,
});
const latest = (owner: string, days: number[]) => days.map((d, i) => ({
  shortCode: `${owner}-L${i}`, url: `https://www.instagram.com/p/${owner}-L${i}/`, type: "Video", videoViewCount: 800,
  displayUrl: `https://cdn.example/${owner}-${i}.jpg`, videoUrl: `https://cdn.example/${owner}-${i}.mp4`, timestamp: daysAgo(d), ownerUsername: owner,
}));

describe("search pipeline", () => {
  const posts = [
    post("P1", "anna", "Skincare unboxing ✨ #ugccreator #skincare"),
    post("P2", "anna", "Open for collabs, DM me"),
    post("P3", "shopx", "Shop now! Free shipping on all skincare #ugc"),
    post("P4", "ben", "UGC creator for makeup brands"),
    post("P5", "carl", "sunset at the beach"),
    post("P6", "dana", "ugc video for skincare, giveaway"),
    post("P7", "eve", "content creator — skincare reviews"),
    post("P8", "gina", "UGC creator, skincare routines"),
  ];
  const profiles = {
    anna: { id: "1", username: "anna", fullName: "Anna Lee", biography: "UGC creator. anna@gmail.com", followersCount: 5200, private: false,
      externalUrl: "https://beacons.ai/anna", latestPosts: latest("anna", [2, 9, 16]) },
    ben: { id: "2", username: "ben", fullName: "Ben", biography: "makeup ugc", followersCount: 300, private: false, latestPosts: latest("ben", [1]) },
    eve: { id: "3", username: "eve", fullName: "Eve", biography: "skincare content creator", followersCount: 9000, private: true },
    gina: { id: "4", username: "gina", fullName: "Gina", biography: "UGC creator", followersCount: 4000, private: false, latestPosts: latest("gina", [45, 60]) },
  };
  const pages = {
    "https://beacons.ai/anna": `<html><head><title>Anna</title></head><body><a href="mailto:hello@annacreates.co">Email</a>
      <a href="https://anna.my.canva.site/portfolio">Portfolio</a><a href="https://www.amazon.com/shop/anna">Amazon</a>
      <div>UGC video package <b>$180</b></div></body></html>`,
  };
  const goodAudit = {
    production_tier: "FLAGSHIP_SMARTPHONE", production_confidence: 0.8, lighting_quality: 8, background_cleanliness: 8,
    direct_response_signals: { has_captions_subtitles: true, clear_product_focus: true, engaging_expression: true },
    minor_is_main_subject: false, brand_safety_flags: [], rejection_reasons: [], aesthetic: "Clean Girl", summary: "Soft light, tidy vanity.",
  };
  const newSearch = (db: any, extra = {}) =>
    db.insert(searches).values({
      name: "Тест", hashtags: ["ugccreator"], keywords: ["skincare", "makeup"], stopWords: ["giveaway"],
      postsPerTag: 10, maxProfiles: 10, minFollowers: 1000, ...extra,
    }).returning();
  const candidates = async (db: any) => {
    const rows = await db.select({ cand: searchCandidates, c: creators }).from(searchCandidates).innerJoin(creators, eq(searchCandidates.creatorId, creators.id));
    return Object.fromEntries(rows.map((r: any) => [r.c.username, r]));
  };

  it("runs the whole funnel: text filter, profiles, activity, link pages, email check, audit, lead", async () => {
    const db = await testDb();
    await addTestKey(db, "apify", "ap");
    await addTestKey(db, "groq", "gq");
    const { mock, calls } = await world(posts, profiles, { pages, llm: goodAudit });
    vi.stubGlobal("fetch", mock);
    const [s] = await newSearch(db);
    expect(await runNextSearch(db)).toBe(true);
    expect(await runNextSearch(db)).toBe(false);

    const [done] = await db.select().from(searches).where(eq(searches.id, s.id));
    expect(done.error).toBeNull();
    expect(done.stats).toEqual({
      posts: 8, authors: 7, shortlisted: 5, profilesReused: 0, profilesFetched: 4, linkPages: 1, withEmail: 1, audited: 1, qualified: 1, leads: 1,
    });
    // магазин і стоп-слово відсіяні безкоштовно — за їхні профілі не платимо
    expect(calls.profileInputs).toEqual([["anna", "ben", "carl", "eve", "gina"]]);
    // сторінку-візитку відкрито лише в автора, що пройшов жорсткі фільтри; аудит — одним запитом
    expect([calls.pages, calls.llm]).toEqual([["https://beacons.ai/anna"], 1]);

    const by = await candidates(db);
    const anna = by.anna;
    expect(anna.cand).toMatchObject({ stage: "qualified", lead: true, readiness: 100, quality: 82 });
    expect(anna.cand.score).toBe(Math.round((anna.cand.fit + 100 + 82) / 3));
    expect(anna.c).toMatchObject({
      followers: 5200, emails: ["anna@gmail.com", "hello@annacreates.co"], affiliate: ["Amazon Storefront"],
      portfolio: ["https://anna.my.canva.site/portfolio"], medianViews: 800, isPrivate: false,
    });
    expect(anna.c.rates).toEqual([{ title: "UGC video package $180", amount: 180, currency: "USD", sourceUrl: "https://beacons.ai/anna" }]);
    expect(anna.c.audit.aesthetic).toBe("Clean Girl");
    expect(existsSync(collagePath(anna.c.id))).toBe(true);
    await rm(collagePath(anna.c.id), { force: true });

    const contacts = await db.select().from(creatorContacts).orderBy(creatorContacts.email);
    expect(contacts.map((k: any) => [k.email, k.status, k.source, k.sourceUrl])).toEqual([
      ["anna@gmail.com", "personal", "bio", "https://www.instagram.com/anna/"],
      ["hello@annacreates.co", "role", "link_page", "https://beacons.ai/anna"],
    ]);

    expect([by.ben.cand.stage, by.ben.cand.reasons.at(-1)]).toEqual(["rejected", "замало підписників (300)"]);
    expect(by.eve.cand.reasons).toContain("закритий профіль");
    expect(by.gina.cand.reasons).toContain("не публікує понад 30 днів");
    expect(by.carl.cand.reasons).toContain("профіль не знайдено");
    expect(by.shopx.cand.stage).toBe("filtered_out");
    expect(by.dana.cand.reasons).toContain("відсіяно стоп-словом");
  });

  it("keeps candidates when the language model is out of quota, and says so", async () => {
    const db = await testDb();
    await addTestKey(db, "apify", "ap");
    await addTestKey(db, "groq", "gq");
    const { mock } = await world(posts, profiles, { pages }); // модель відповідає 429 на годину
    vi.stubGlobal("fetch", mock);
    const [s] = await newSearch(db);
    await runNextSearch(db);
    const [done] = await db.select().from(searches).where(eq(searches.id, s.id));
    expect(done.status).toBe("done");
    expect(done.stats).toMatchObject({ qualified: 1, audited: 0, leads: 0 });
    expect(done.stats.note).toMatch(/Візуальний аудит зупинено/);
    const by = await candidates(db);
    expect(by.anna.cand).toMatchObject({ stage: "qualified", quality: null, lead: false });
  });

  it("rejects on audit findings: children as main subject and low quality", async () => {
    const db = await testDb();
    await addTestKey(db, "apify", "ap");
    await addTestKey(db, "groq", "gq");
    const bad = { ...goodAudit, production_tier: "LOWEND_DEGRADED", lighting_quality: 2, background_cleanliness: 2, minor_is_main_subject: true,
      direct_response_signals: { has_captions_subtitles: false, clear_product_focus: false, engaging_expression: false } };
    const { mock } = await world(posts, profiles, { pages, llm: bad });
    vi.stubGlobal("fetch", mock);
    await newSearch(db);
    await runNextSearch(db);
    const by = await candidates(db);
    expect(by.anna.cand.stage).toBe("rejected");
    expect(by.anna.cand.reasons).toEqual(expect.arrayContaining(["головні герої контенту — діти", "низька якість зйомки (20)"]));
    await rm(collagePath(by.anna.c.id), { force: true });
  });

  it("re-running reuses cached posts, profiles, link pages and audits without paying again", async () => {
    const db = await testDb();
    await addTestKey(db, "apify", "ap");
    await addTestKey(db, "groq", "gq");
    const { mock, calls } = await world(posts, profiles, { pages, llm: goodAudit });
    vi.stubGlobal("fetch", mock);
    const [s] = await newSearch(db);
    await runNextSearch(db);
    const paid = (await db.select().from(usageEvents)).length;
    await db.update(searches).set({ status: "running" }).where(eq(searches.id, s.id)); // сервер «упав» посеред пошуку
    await requeueInterrupted(db);
    await runNextSearch(db);
    const [again] = await db.select().from(searches).where(eq(searches.id, s.id));
    expect(again.status).toBe("done");
    expect(again.stats).toMatchObject({ profilesReused: 5, profilesFetched: 0, linkPages: 0, audited: 0, qualified: 1, leads: 1 });
    expect([calls.hashtag, calls.profile, calls.pages.length, calls.llm]).toEqual([1, 1, 1, 1]);
    expect((await db.select().from(usageEvents)).length).toBe(paid);
    const by = await candidates(db);
    expect(by.anna.cand).toMatchObject({ lead: true, quality: 82 });
    await rm(collagePath(by.anna.c.id), { force: true });
  });

  it("filters by country and language when known, lets unknown through, and flags suspicious engagement", async () => {
    const db = await testDb();
    await addTestKey(db, "apify", "ap");
    const local = {
      ...profiles,
      anna: { ...profiles.anna, biography: "UGC creator 🇺🇸 anna@gmail.com", followersCount: 80000,
        latestPosts: latest("anna", [2, 9]).map((p) => ({ ...p, likesCount: 40 })) },
      ben: { ...profiles.ben, biography: "makeup ugc 🇮🇳", followersCount: 3000 },
      eve: { ...profiles.eve, private: false, biography: "skincare content creator", latestPosts: latest("eve", [3]) },
    };
    const { mock } = await world(posts, local, { pages });
    vi.stubGlobal("fetch", mock);
    await newSearch(db, { auditLimit: 0, countries: ["US", "GB"], languages: ["en"] });
    await runNextSearch(db);
    const by = await candidates(db);
    expect([by.anna.c.country, by.anna.cand.stage]).toEqual(["US", "qualified"]);
    expect(by.anna.cand.reasons.join()).toMatch(/залученість 0\.05% — можлива накрутка/);
    expect([by.ben.c.country, by.ben.cand.reasons.at(-1)]).toEqual(["IN", "інша країна (IN)"]);
    expect([by.eve.c.country, by.eve.cand.stage]).toEqual([null, "qualified"]);
    expect(by.eve.cand.reasons).toContain("країну не визначено");
  });

  it("a suppressed creator is erased and never collected again", async () => {
    const db = await testDb();
    await addTestKey(db, "apify", "ap");
    const { mock, calls } = await world(posts, profiles, { pages });
    vi.stubGlobal("fetch", mock);
    const [s] = await newSearch(db, { auditLimit: 0 });
    await runNextSearch(db);
    const anna = (await candidates(db)).anna.c;
    expect(await suppressCreator(db, anna.id, "запит автора")).toBe(true);
    expect(await db.select().from(creators).where(eq(creators.username, "anna"))).toHaveLength(0);
    expect(await db.select().from(contentItems).where(eq(contentItems.authorUsername, "anna"))).toHaveLength(0);
    expect(await db.select().from(creatorContacts)).toHaveLength(0);
    const keys = (await db.select().from(suppressions)).map((r: any) => r.key);
    expect(keys).toContain("instagram:anna");
    expect(keys.filter((k: string) => k.startsWith("email:"))).toHaveLength(2);
    expect(keys.join()).not.toContain("gmail"); // адреси зберігаються лише як хеші

    await db.update(searches).set({ status: "queued" }).where(eq(searches.id, s.id));
    await db.delete(searchCandidates);
    await runNextSearch(db);
    expect((await candidates(db)).anna).toBeUndefined();
    expect(calls.profileInputs.flat().filter((u) => u === "anna")).toHaveLength(1);
  });

  it("records the failure reason and estimates cost", async () => {
    const db = await testDb(); // немає ключа Apify
    const [s] = await newSearch(db);
    await runNextSearch(db);
    const [failed] = await db.select().from(searches).where(eq(searches.id, s.id));
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/apify/);
    expect(estimateCostUsd({ hashtags: ["a", "b"], postsPerTag: 50, maxProfiles: 150 })).toBe(0.65);
  });
});
