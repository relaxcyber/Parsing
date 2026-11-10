import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { creators, searchCandidates, searches, usageEvents } from "@/db/schema";
import { toCsv } from "@/search/csv";
import { estimateCostUsd, requeueInterrupted, runNextSearch } from "@/search/pipeline";
import { extractEmails, scoreCandidate } from "@/search/signals";
import { addTestKey, testDb } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

describe("text scoring", () => {
  const base = { keywords: ["skincare", "makeup"], stopWords: [] as string[] };
  it("rewards UGC and collaboration signals and niche matches", () => {
    const s = scoreCandidate({ ...base, texts: ["New unboxing! #ugccreator #skincare"], ignoreTags: ["ugccreator"], bio: "UGC creator | collabs: me@mail.com", links: ["https://beacons.ai/me"] });
    expect(s.readiness).toBe(10);
    expect(s.fit).toBe(7.1);
    expect(s.reasons).toEqual(expect.arrayContaining(["називає себе UGC-креатором", "вказав email", "є сторінка з посиланнями", "ніша: skincare"]));
    expect(s.blocked).toBe(false);
  });
  it("penalises shops and blocks stop words; no niche words means fit is unknown", () => {
    const shop = scoreCandidate({ ...base, texts: ["Shop now, free shipping! #ugc"] });
    expect([shop.readiness, shop.negative]).toEqual([0, true]);
    // хештег самого пошуку є в кожному дописі — це не сигнал
    expect(scoreCandidate({ keywords: [], stopWords: [], texts: ["sunset #ugccreator"], ignoreTags: ["ugccreator"] }).readiness).toBe(0);
    expect(shop.reasons).toContain("мінус: схоже на магазин");
    expect(scoreCandidate({ keywords: [], stopWords: ["giveaway"], texts: ["ugc creator, giveaway inside"] })).toMatchObject({ fit: null, blocked: true });
  });
  it("matches Cyrillic niche words and whole words only", () => {
    expect(scoreCandidate({ keywords: ["догляд"], stopWords: [], texts: ["Мій догляд за шкірою"] }).fit).toBe(10);
    expect(scoreCandidate({ keywords: ["art"], stopWords: [], texts: ["a smart start"] }).fit).toBe(0);
  });
  it("extracts emails from a bio", () => {
    expect(extractEmails("Collabs 📩 Hello.Me@Mail.co.uk. or pic@2x.png")).toEqual(["hello.me@mail.co.uk"]);
  });
});

describe("csv", () => {
  it("quotes cells and neutralises spreadsheet formulas", () => {
    expect(toCsv(["a", "b"], [["=SUM(1)", 'say "hi", ok'], ["-5", -5]])).toBe('﻿a,b\r\n\'=SUM(1),"say ""hi"", ok"\r\n\'-5,-5\r\n');
  });
});

/** Підробка Apify: хештег-актор віддає дописи, профільний — профілі для запитаних імен. */
function apify(posts: any[], profiles: Record<string, any>) {
  const runs = new Map<string, any[]>();
  const calls = { hashtag: 0, profile: 0, profileInputs: [] as string[][] };
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
    throw new Error(`unexpected ${url}`);
  });
  return { mock, calls };
}

const post = (code: string, owner: string, caption: string, tag = "ugccreator") => ({
  tag, shortCode: code, url: `https://www.instagram.com/p/${code}/`, type: "Image", caption, hashtags: [tag],
  ownerUsername: owner, ownerId: `id-${owner}`, ownerFullName: owner.toUpperCase(), displayUrl: "https://cdn.example/i.jpg",
});

describe("search pipeline", () => {
  const posts = [
    post("P1", "anna", "Skincare unboxing ✨ #ugccreator #skincare"),
    post("P2", "anna", "Open for collabs, DM me"),
    post("P3", "shopx", "Shop now! Free shipping on all skincare #ugc"),
    post("P4", "ben", "UGC creator for makeup brands"),
    post("P5", "carl", "sunset at the beach"),
    post("P6", "dana", "ugc video for skincare, giveaway"),
    post("P7", "eve", "content creator — skincare reviews"),
  ];
  const profiles = {
    anna: { id: "1", username: "anna", fullName: "Anna", biography: "UGC creator. anna@mail.com", followersCount: 5200, private: false, externalUrl: "https://beacons.ai/anna" },
    ben: { id: "2", username: "ben", fullName: "Ben", biography: "makeup ugc", followersCount: 300, private: false },
    eve: { id: "3", username: "eve", fullName: "Eve", biography: "skincare content creator", followersCount: 9000, private: true },
  };
  const newSearch = (db: any, extra = {}) =>
    db.insert(searches).values({
      name: "Тест", hashtags: ["ugccreator"], keywords: ["skincare", "makeup"], stopWords: ["giveaway"],
      postsPerTag: 10, maxProfiles: 10, minFollowers: 1000, ...extra,
    }).returning();

  it("funnels posts to a qualified shortlist and pays for profiles of shortlisted authors only", async () => {
    const db = await testDb();
    await addTestKey(db, "apify", "ap");
    const { mock, calls } = apify(posts, profiles);
    vi.stubGlobal("fetch", mock);
    const [s] = await newSearch(db);
    expect(await runNextSearch(db)).toBe(true);
    expect(await runNextSearch(db)).toBe(false);

    const [done] = await db.select().from(searches).where(eq(searches.id, s.id));
    expect(done.status).toBe("done");
    expect(done.stats).toEqual({ posts: 7, authors: 6, shortlisted: 4, profilesReused: 0, profilesFetched: 3, qualified: 1 });
    // магазин і стоп-слово відсіяні безкоштовно — за їхні профілі не платимо
    expect(calls.profileInputs).toEqual([["anna", "ben", "carl", "eve"]]);

    const rows = await db.select({ cand: searchCandidates, c: creators }).from(searchCandidates).innerJoin(creators, eq(searchCandidates.creatorId, creators.id));
    const by = Object.fromEntries(rows.map((r: any) => [r.c.username, r]));
    expect(by.anna.cand.stage).toBe("qualified");
    expect(by.anna.c).toMatchObject({ followers: 5200, emails: ["anna@mail.com"], links: ["https://beacons.ai/anna"], isPrivate: false });
    expect(by.anna.cand.postIds).toHaveLength(2);
    expect([by.ben.cand.stage, by.ben.cand.reasons.at(-1)]).toEqual(["rejected", "замало підписників (300)"]);
    expect(by.eve.cand.reasons).toContain("закритий профіль");
    expect(by.shopx.cand.stage).toBe("filtered_out");
    expect(by.dana.cand.reasons).toContain("відсіяно стоп-словом");
    expect(by.shopx.cand.reasons).toContain("відсіяно за текстом дописів");
    expect([by.carl.cand.stage, by.carl.cand.reasons]).toEqual(["rejected", ["профіль не знайдено", "немає ознак готовності до співпраці"]]);
  });

  it("re-running reuses cached posts and fresh profiles without paying again", async () => {
    const db = await testDb();
    await addTestKey(db, "apify", "ap");
    const { mock, calls } = apify(posts, profiles);
    vi.stubGlobal("fetch", mock);
    const [s] = await newSearch(db);
    await runNextSearch(db);
    const paid = (await db.select().from(usageEvents)).length;
    await db.update(searches).set({ status: "running" }).where(eq(searches.id, s.id)); // сервер «упав» посеред пошуку
    await requeueInterrupted(db);
    await runNextSearch(db);
    const [again] = await db.select().from(searches).where(eq(searches.id, s.id));
    expect(again.status).toBe("done");
    expect(again.stats).toMatchObject({ profilesReused: 4, profilesFetched: 0, qualified: 1 });
    expect([calls.hashtag, calls.profile]).toEqual([1, 1]);
    expect((await db.select().from(usageEvents)).length).toBe(paid);
    expect(await db.select().from(searchCandidates)).toHaveLength(6);
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
