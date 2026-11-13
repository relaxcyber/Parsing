import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  AGENCY, brandBase, brandMetrics, brandVerdict, recordCreatorAds, requestVerify, rowsCsv, runBrandVerify, scoutMetrics, scoutRows, sizeFits, checkPitch, pageEmails, collectCollabs, createScout, pickEmail, pitchFacts, queuePitches, rankCollabs, runBrandScouts, setBrandVerdict,
} from "@/brands";
import type { PostFacts } from "@/analysis/posts";
import { brandAccounts, brandScouts, creators, searches, type BrandCreator, type BrandLead } from "@/db/schema";
import { addTestKey, testDb } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const fact = (over: Partial<PostFacts>): PostFacts => ({
  url: `https://www.instagram.com/p/${over.shortCode ?? "x"}/`, shortCode: "x", caption: "", hashtags: [], likes: 10, comments: 1, views: null,
  publishedAt: new Date("2026-10-01"), pinned: false, isVideo: false, mentions: [], coauthors: [], tagged: [], paid: null, latestComments: [], ...over,
});

describe("who is a brand", () => {
  it("decides from the Instagram profile fields, without a model", () => {
    expect(brandVerdict({ businessCategoryName: "Pet Supplies", externalUrl: "https://pawsome.co" }).verdict).toBe("brand");
    expect(brandVerdict({ businessCategoryName: "Digital creator" }).verdict).toBe("not_brand");
    expect(brandVerdict({ businessCategoryName: "Photographer", isBusinessAccount: true, externalUrl: "https://carl.photo" }).verdict).toBe("not_brand");
    expect(brandVerdict({ isBusinessAccount: true, externalUrl: "https://barkgear.com" }).verdict).toBe("brand");
    // Мультипосилання — не власний сайт бренду.
    expect(brandVerdict({ isBusinessAccount: true, externalUrl: "https://linktr.ee/x" }).verdict).toBe("unsure");
    expect(brandVerdict({ externalUrl: "https://treats.shop", biography: "Handmade dog treats. Ships worldwide" }).verdict).toBe("brand");
    expect(brandVerdict({ businessCategoryName: "None", biography: "just me and my dog" }).verdict).toBe("unsure");
    expect(brandVerdict({ private: true, businessCategoryName: "Pet Supplies" }).verdict).toBe("not_brand");
    // Агенції публікують спільні дописи з авторами: такі акаунти не беремо як авторів.
    for (const a of ["influpublicidad", "theglowcollab.in", "celestetalentagency", "blendmarketingeg"]) expect(AGENCY.test(a)).toBe(true);
    for (const a of ["mia.corgis Mia", "talented.tom", "anna_collins"]) expect(AGENCY.test(a)).toBe(false);
  });

  it("finds brands in ads only, skips other creators, platforms and repeats", () => {
    const { collabs, adPosts } = collectCollabs([
      { creator: "anna", followers: 12000, posts: [
        fact({ shortCode: "a1", caption: "new harness", tagged: ["barkgear"], paid: true }),
        fact({ shortCode: "a2", caption: "walk with @pawsomeco treats #ad", mentions: ["pawsomeco"] }),
        fact({ shortCode: "a3", caption: "with my friend", coauthors: ["ben"] }),
        fact({ shortCode: "a4", caption: "lovely day with @pawsomeco", mentions: ["pawsomeco"] }), // не реклама
      ] },
      { creator: "ben", followers: 8000, posts: [
        fact({ shortCode: "b1", caption: "use code BEN10 at @pawsomeco", mentions: ["pawsomeco"] }),
        fact({ shortCode: "b2", caption: "#gifted thanks @instagram", mentions: ["instagram"] }),
        fact({ shortCode: "b3", caption: "content day", coauthors: ["sora.rojasugc"] }), // інший автор, не бренд
      ] },
    ], new Set(["anna", "ben"]));
    expect(adPosts).toBe(6);
    expect([...collabs.keys()].sort()).toEqual(["barkgear", "pawsomeco"]);
    expect(collabs.get("pawsomeco")!.map((c) => c.creator)).toEqual(["anna", "ben"]);
    expect(collabs.get("barkgear")![0]).toMatchObject({ creator: "anna", paid: true, followers: 12000 });
    expect(rankCollabs(collabs).map(([h]) => h)).toEqual(["pawsomeco", "barkgear"]);
  });

  it("picks the partnership address and skips service ones", () => {
    expect(pickEmail(["noreply@pawsome.co", "info@pawsome.co", "partnerships@pawsome.co"], "https://pawsome.co")).toBe("partnerships@pawsome.co");
    expect(pickEmail(["hello@agency.com", "hello@pawsome.co"], "https://www.pawsome.co/shop")).toBe("hello@pawsome.co");
    expect(pickEmail(["x@sentry.io", "logo@2x.png"], null)).toBeNull();
    expect(pageEmails(`<a href="mailto:Hello%40pawsome.co?subject=hi">mail</a><script>var x="dev@vendor.io"</script><p>press&#64;pawsome.co</p>`))
      .toEqual(["hello@pawsome.co", "press@pawsome.co"]);
  });
});

const creator: BrandCreator = {
  name: "Mia", handle: "mia.corgis", niche: "dog care", followers: "12K", about: "I film short UGC videos with my two corgis.",
  portfolio: "https://mia.my.canva.site", offer: "A 30 sec UGC video for your ads in 7 days.",
};
const lead: BrandLead = {
  handle: "pawsomeco", name: "Pawsome", bio: "Natural dog treats. Ships US", category: "Pet Supplies", followers: 54000, website: "https://pawsome.co",
  email: "partnerships@pawsome.co", emailSource: "https://pawsome.co/pages/contact", verdict: "brand", verdictWhy: "",
  collabs: [{ creator: "anna", followers: 12000, postUrl: "https://www.instagram.com/p/a2/", reason: "", paid: false, at: null }],
};
const GOOD_BODY = "Hi Pawsome team,\nyour natural dog treats look like something my corgis would go crazy for. I saw you work with creators like @anna.\nI'm Mia, I film short UGC videos with my two corgis (12K followers). I can make a 30 sec video for your ads in 7 days.\nPortfolio: https://mia.my.canva.site\nWant me to send my rates?\nMia";

describe("pitch from the creator", () => {
  it("allows only facts: numbers, links and handles", () => {
    const f = pitchFacts(creator, lead);
    expect(f.collab_examples).toEqual(["@anna"]);
    expect(checkPitch("corgi videos for pawsome", GOOD_BODY, f)).toEqual([]);
    expect(checkPitch("corgi videos", GOOD_BODY.replace(/\nMia$/, ""), f)).toEqual(["лист не підписано іменем Mia"]);
    // Дивні імена авторів у лист не потрапляють.
    expect(pitchFacts(creator, { ...lead, collabs: [{ ...lead.collabs[0], creator: "___anuuuu__2.0" }] }).collab_examples).toEqual([]);
    const bad = checkPitch("50% off collab", "Hi! I got 300K views for @barkgear. See https://mia.ugc.com or write mia@mail.com. Best regards, null", f).join(" | ");
    expect(bad).toMatch(/«50»/);
    expect(bad).toMatch(/«300K»|«300»/);
    expect(bad).toMatch(/@barkgear/);
    expect(bad).toMatch(/mia\.ugc\.com/);
    expect(bad).toMatch(/email/);
    expect(bad).toMatch(/null/);
  });
});

function world(llmCalls: string[]) {
  const runs = new Map<string, any[]>();
  const latest = (owner: string, posts: any[]) => posts.map((p) => ({ type: "Image", ownerUsername: owner, url: `https://www.instagram.com/p/${p.shortCode}/`, timestamp: "2026-10-01T10:00:00Z", ...p }));
  const tagPosts = [
    { shortCode: "P1", ownerUsername: "anna", caption: "walk with @pawsomeco treats #ad", mentions: ["pawsomeco"] },
    { shortCode: "P2", ownerUsername: "ben", caption: "morning walk" },
    { shortCode: "P3", ownerUsername: "pawsomeco", caption: "Shop now, free shipping" },
  ].map((p) => ({ type: "Image", url: `https://www.instagram.com/p/${p.shortCode}/`, hashtags: ["dogsofinstagram"], timestamp: "2026-10-02T10:00:00Z", ...p }));
  const profiles: Record<string, any> = {
    anna: { username: "anna", fullName: "Anna", biography: "corgi mom", followersCount: 12000, businessCategoryName: "Digital creator", latestPosts: latest("anna", [
      { shortCode: "A1", caption: "new harness", taggedUsers: [{ username: "barkgear" }], paidPartnership: true },
      { shortCode: "A2", caption: "Thanks to @carlphoto for the pics #ad", mentions: ["carlphoto"] },
      { shortCode: "A3", caption: "with my friend", coauthorProducers: [{ username: "ben" }] },
    ]) },
    ben: { username: "ben", fullName: "Ben", biography: "dog dad", followersCount: 8000, latestPosts: latest("ben", [
      { shortCode: "B1", caption: "use code BEN10 at @pawsomeco", mentions: ["pawsomeco"] },
    ]) },
    pawsomeco: { username: "pawsomeco", fullName: "Pawsome", biography: "Natural dog treats. Ships US", followersCount: 54000, businessCategoryName: "Pet Supplies", isBusinessAccount: true, externalUrl: "https://pawsome.co", latestPosts: [] },
    barkgear: { username: "barkgear", fullName: "Bark Gear", biography: "Dog harnesses. Collabs: hi@barkgear.com", followersCount: 9000, isBusinessAccount: true, externalUrl: "https://barkgear.com" },
    carlphoto: { username: "carlphoto", fullName: "Carl", biography: "pet photographer", followersCount: 2000, businessCategoryName: "Photographer" },
  };
  const pages: Record<string, string> = {
    "https://pawsome.co": "<html><body><h1>Pawsome</h1><p>Natural treats</p></body></html>",
    "https://pawsome.co/pages/contact": `<html><body><a href="mailto:noreply@pawsome.co">x</a> Partnerships: <a href="mailto:partnerships@pawsome.co">partnerships@pawsome.co</a></body></html>`,
  };
  const calls = { profileInputs: [] as string[][], pages: [] as string[] };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
    if (url.includes("/users/me/limits")) return Response.json({ data: { limits: { maxMonthlyUsageUsd: 5 }, current: { monthlyUsageUsd: 0.1 } } });
    if (url.includes("/runs?")) {
      const id = `run${runs.size + 1}`;
      const input = JSON.parse(init.body);
      if (url.includes("hashtag-scraper")) runs.set(id, tagPosts);
      else {
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
      llmCalls.push("pitch");
      const user = JSON.parse(init.body).messages[1].content as string;
      const body = user.includes("pawsomeco") ? GOOD_BODY : "Hi Bark Gear team,\nyour dog harnesses look great. I'm Mia, I film short UGC videos with my two corgis (12K followers). Want me to send my rates?\nMia";
      return Response.json({ choices: [{ message: { content: JSON.stringify({ subject: "corgi videos", body, translation_uk: "Привіт…" }) } }] });
    }
    const page = pages[url.replace(/\/$/, "")];
    if (page) {
      calls.pages.push(url);
      return new Response(page, { headers: { "content-type": "text/html" } });
    }
    return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
  }));
  return calls;
}

describe("brands for a creator end to end", () => {
  it("collects niche posts, finds brands in ads, checks their profiles, finds emails, writes pitches and exports a file", async () => {
    const db = await testDb();
    await addTestKey(db, "apify", "ap");
    await addTestKey(db, "groq", "gq");
    const llm: string[] = [];
    const calls = world(llm);
    const id = await createScout(db, { niche: "dog care", hashtags: ["#DogsOfInstagram"], postsPerTag: 30, maxCreators: 40, maxBrands: 30, creator });
    expect(await runBrandScouts(db)).toBe(true);
    let [s] = await db.select().from(brandScouts).where(eq(brandScouts.id, id));
    expect(s.error).toBeNull();
    expect(s.status).toBe("done");
    expect(s.hashtags).toEqual(["dogsofinstagram"]);
    // Бренд, що сам постить у хештегу, — не автор; профіль бренду вдруге не купуємо.
    expect(calls.profileInputs).toEqual([["anna", "ben", "pawsomeco"], ["barkgear", "carlphoto"]]);
    expect(s.stats).toMatchObject({ posts: 3, creators: 2, adPosts: 5, candidates: 3, brandProfiles: 3, withEmail: 2 });
    const by = Object.fromEntries(s.brands.map((b) => [b.handle, b]));
    expect(by.pawsomeco).toMatchObject({ verdict: "brand", email: "partnerships@pawsome.co", emailSource: "https://pawsome.co/pages/contact" });
    expect(new Set(by.pawsomeco.collabs.map((c) => c.creator))).toEqual(new Set(["anna", "ben"]));
    expect(by.barkgear).toMatchObject({ verdict: "brand", email: "hi@barkgear.com", emailSource: "біо Instagram" });
    expect(by.carlphoto.verdict).toBe("not_brand");
    expect(s.brands.map((b) => b.handle)).toEqual(["pawsomeco", "barkgear", "carlphoto"]);
    // Сайт фотографа не відкриваємо; бренд з email у біо — теж.
    expect(calls.pages.every((u) => u.includes("pawsome.co"))).toBe(true);

    // Листи: у черзі лише бренди з email, по одному за крок.
    expect(await queuePitches(db, s)).toBe(2);
    expect(await runBrandScouts(db)).toBe(true);
    expect(await runBrandScouts(db)).toBe(true);
    expect(await runBrandScouts(db)).toBe(false);
    [s] = await db.select().from(brandScouts).where(eq(brandScouts.id, id));
    expect(s.pitchQueue).toEqual([]);
    const paws = s.brands.find((b) => b.handle === "pawsomeco")!;
    expect(paws.pitch).toMatchObject({ subject: "corgi videos", issues: [] });
    expect(paws.pitch!.body).toMatch(/@anna/);
    expect(llm).toEqual(["pitch", "pitch"]);

    // Ваше рішення: фотограф — бренд (наприклад, студія); файл без «не бренд».
    await setBrandVerdict(db, id, "carlphoto", "not_brand");
    [s] = await db.select().from(brandScouts).where(eq(brandScouts.id, id));
    const { csv, rows } = rowsCsv(scoutRows(s, await scoutMetrics(db, s)));
    expect(rows).toBe(2);
    const lines = csv.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
    expect(lines[0]).toBe("brand,instagram,name,category,brand_followers,website,email,creators_worked_with,creators_last_90_days,repeat_creators,sponsored_posts,"
      + "paid_partnership_posts,last_collab,creator_size,sponsored_post_er_pct,creator_ugc_rates_usd,example_creators,example_post,email_subject,email_body");
    expect(lines[1]).toMatch(/^pawsomeco,https:\/\/www\.instagram\.com\/pawsomeco\/,Pawsome,Pet Supplies,54000,https:\/\/pawsome\.co,partnerships@pawsome\.co,2,2,0,2,0,2026-10-02,8K–12K \(median 10K\),,,"anna, ben",https:\/\/www\.instagram\.com\/p\//);
    // Перевірені профілі й ваше рішення — у загальній базі брендів.
    const accounts = Object.fromEntries((await db.select().from(brandAccounts)).map((a) => [a.handle, a]));
    expect(accounts.pawsomeco).toMatchObject({ verdict: "brand", email: "partnerships@pawsome.co" });
    expect(accounts.pawsomeco.checkedAt).not.toBeNull();
    expect(accounts.carlphoto).toMatchObject({ verdict: "not_brand", byYou: true });
    expect(csv).not.toMatch(/carlphoto/);
  });
});

describe("brand base from creator searches", () => {
  const day = (n: number) => new Date(Date.now() - n * 86_400_000);
  const ad = (code: string, tagged: string[], likes: number, at: Date, paid = false) =>
    fact({ shortCode: code, caption: "#ad new collar", tagged, likes, paid, publishedAt: at });

  it("collects brands from every creator search for free and counts the numbers buyers look at", async () => {
    const db = await testDb();
    const [search] = await db.insert(searches).values({ name: "t", hashtags: ["dogs"] }).returning();
    const [mia, zoe] = await db.insert(creators).values([
      { platform: "instagram", username: "mia", followers: 9000, rates: [{ title: "UGC video", amount: 150, currency: "USD", sourceUrl: "https://beacons.ai/mia" }] },
      { platform: "instagram", username: "zoe", followers: 30000 },
    ]).returning();
    await recordCreatorAds(db, mia, [ad("m1", ["cozycollar"], 450, day(10), true), ad("m2", ["zoe"], 100, day(5))], search.id);
    await recordCreatorAds(db, zoe, [ad("z1", ["cozycollar"], 600, day(20)), ad("z2", ["cozycollar"], 600, day(200)), fact({ shortCode: "z3", caption: "my dog", tagged: ["oldbrand"] })], search.id);
    // Повтор того самого допису не дублюється.
    await recordCreatorAds(db, mia, [ad("m1", ["cozycollar"], 450, day(10), true)], search.id);

    const rows = await brandBase(db);
    // Відмітка іншого автора (zoe) — не бренд; допис без реклами — не доказ.
    expect(rows.map((r) => r.a.handle)).toEqual(["cozycollar"]);
    const m = rows[0].m;
    expect(m).toMatchObject({ creators: 2, active90: 2, posts: 3, paidPosts: 1, repeatCreators: 1, followers: { min: 9000, median: 19500, max: 30000 }, adEr: 2, rates: { min: 150, max: 150, creators: 1 } });
    expect(m.examples.map((e) => e.creator)).toEqual(["zoe", "mia"]);
    expect(sizeFits(m, 8000)).toBe(true);
    expect((await brandBase(db, { size: 100_000 })).length).toBe(0);
    expect((await brandBase(db, { min: 3 })).length).toBe(0);
    expect((await brandBase(db, { q: "collar" })).length).toBe(1);
    expect(brandMetrics([]).followers).toBeNull();

    // Платна перевірка профілю на ваш запит: вердикт коду, email з біо.
    await addTestKey(db, "apify", "ap");
    const runs = new Map<string, any[]>();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
      if (url.includes("/users/me/limits")) return Response.json({ data: { limits: { maxMonthlyUsageUsd: 5 }, current: { monthlyUsageUsd: 0.1 } } });
      if (url.includes("/runs?")) {
        const id = `run${runs.size + 1}`;
        runs.set(id, JSON.parse(init.body).usernames.map((u: string) => u === "cozycollar"
          ? { username: u, fullName: "Cozy Collar", biography: "Soft collars. hello@cozycollar.com", followersCount: 7000, businessCategoryName: "Pet Supplies", externalUrl: "https://cozycollar.com" }
          : { error: "not_found" }));
        return Response.json({ data: { id, status: "RUNNING", defaultDatasetId: id } });
      }
      const run = url.match(/actor-runs\/(run\d+)/)?.[1];
      if (run) return Response.json({ data: { id: run, status: "SUCCEEDED", defaultDatasetId: run, usageTotalUsd: 0.01 } });
      const ds = url.match(/datasets\/(run\d+)\/items/)?.[1];
      if (ds) return Response.json(runs.get(ds));
      return new Response("not found", { status: 404 });
    }));
    expect(await runBrandVerify(db)).toBe(false);
    expect(await requestVerify(db, [rows[0].a.id])).toBe(1);
    expect(await runBrandVerify(db)).toBe(true);
    expect(await runBrandVerify(db)).toBe(false);
    const [a] = await db.select().from(brandAccounts).where(eq(brandAccounts.handle, "cozycollar"));
    expect(a).toMatchObject({ verdict: "brand", email: "hello@cozycollar.com", category: "Pet Supplies", followers: 7000, verifyRequestedAt: null });
    expect((await brandBase(db, { emailOnly: true, show: "checked" })).map((r) => r.a.handle)).toEqual(["cozycollar"]);
    // Уже перевірений повторно не ставиться в чергу.
    expect(await requestVerify(db, [a.id])).toBe(0);
  });
});
