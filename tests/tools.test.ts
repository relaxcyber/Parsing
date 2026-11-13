import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { backupDatabase, restoreBackup } from "@/backup";
import { fetchTikTokProfiles, parseTikTokProfile, tiktokHandles } from "@/collect/tiktok";
import { clients, creatorContacts, creators, mailboxes, outreachMessages, outreachThreads, searchCandidates, searches, timeEntries } from "@/db/schema";
import { encryptSecret } from "@/keys/crypto";
import { checkDomain, effectiveLimit, guardMailbox, pauseReason, pickMailbox, verifiedVerdict, verifyEmail } from "@/outreach/deliver";
import { DEFAULT_POLICY } from "@/outreach/policy";
import { billingMonths, clientProfit, profitability } from "@/outreach/profit";
import { runNextSearch } from "@/search/pipeline";
import { planTikTokSources } from "@/search/sources";
import { addTestKey, testDb } from "./helpers";

process.env.TIKTOK_DELAY_MS = "0";
afterEach(() => vi.unstubAllGlobals());

/** Сторінка профілю TikTok у тому вигляді, який віддає tiktok.com (лише потрібна частина). */
function ttPage(user: Record<string, unknown>, stats: Record<string, unknown> = {}, statusCode = 0) {
  const data = { __DEFAULT_SCOPE__: { "webapp.app-context": {}, "webapp.user-detail": { statusCode, statusMsg: "", userInfo: { user, stats: {}, statsV2: stats, itemList: [] } } } };
  return `<html><head></head><body><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(data)}</script></body></html>`;
}
const anna = ttPage(
  { id: "1", uniqueId: "Anna.UGC", nickname: "Anna | UGC", signature: "UGC creator 🎥 skincare\ncollabs: anna.ugc@gmail.com", verified: false, privateAccount: false, bioLink: { link: "beacons.ai/annaugc" }, commerceUserInfo: { commerceUser: false } },
  { followerCount: "12500", followingCount: "310", videoCount: "84", heart: "420000" },
);

describe("TikTok profiles without Apify", () => {
  it("reads the public profile JSON into the same shape as an Instagram profile", () => {
    const r = parseTikTokProfile(anna);
    expect(r && "raw" in r && r.raw).toMatchObject({
      platform: "tiktok", username: "anna.ugc", fullName: "Anna | UGC", followersCount: 12500, followsCount: 310, postsCount: 84, likesTotal: 420000,
      externalUrl: "https://beacons.ai/annaugc", isBusinessAccount: false, private: false, latestPosts: [],
    });
    expect(parseTikTokProfile(ttPage({}, {}, 10221))).toEqual({ missing: "профіль не знайдено" });
    expect(parseTikTokProfile("<html>Please wait…</html>")).toBeNull();
  });
  it("stops politely when TikTok starts refusing, and reports the rest as skipped", async () => {
    const pages: Record<string, Response | (() => Response)> = {
      "anna.ugc": () => new Response(anna),
      gone: () => new Response("", { status: 404 }),
      limited: () => new Response("", { status: 429 }),
      after: () => new Response(anna),
    };
    const fetchImpl = vi.fn(async (url: string) => (pages[url.split("@")[1]] as () => Response)()) as unknown as typeof fetch;
    const r = await fetchTikTokProfiles(["@anna.ugc", "gone", "limited", "after"], { delayMs: 0, fetchImpl });
    expect(r.collected.map((c) => c.item.author?.username)).toEqual(["anna.ugc"]);
    expect(r.collected[0].item).toMatchObject({ source: "tiktok", kind: "profile", url: "https://www.tiktok.com/@anna.ugc", via: "tiktok-page" });
    expect(r.skipped).toEqual(["gone: профіль не знайдено", "limited: TikTok відповів 429", "after: TikTok тимчасово обмежив запити"]);
    expect(r.limited).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it("finds TikTok handles in links and text", () => {
    expect(tiktokHandles(["https://www.tiktok.com/@anna.ugc/video/123", "my tiktok: tiktok.com/@Bob_Creates.", "instagram.com/x"])).toEqual(["anna.ugc", "bob_creates"]);
  });

  it("a TikTok search: sources from your list and your Instagram base, free profiles, lifetime engagement", async () => {
    const db = await testDb();
    // Автор Instagram, що вже пройшов відбір і має TikTok — стане кандидатом TikTok-пошуку.
    const [ig] = await db.insert(creators).values({ platform: "instagram", username: "anna_ig", socials: { tiktok: "anna.ugc" } }).returning();
    const [old] = await db.insert(searches).values({ name: "ig", hashtags: ["ugc"], status: "done" }).returning();
    await db.insert(searchCandidates).values({ searchId: old.id, creatorId: ig.id, stage: "qualified" });
    const [s] = await db.insert(searches).values({
      name: "tt", platform: "tiktok", hashtags: [], keywords: ["skincare"], sources: { usernames: ["https://www.tiktok.com/@shop.official"] }, auditLimit: 0, deepLimit: 0,
    }).returning();
    expect(planTikTokSources(s).map((t) => t.label)).toEqual(["ваш список", "TikTok авторів з бази Instagram"]);
    const shop = ttPage({ id: "2", uniqueId: "shop.official", nickname: "Shop", signature: "Official store. Free shipping!", commerceUserInfo: { commerceUser: true } }, { followerCount: "90000", videoCount: "10", heart: "5000" });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("tiktok.com/@anna.ugc")) return new Response(anna);
      if (url.includes("tiktok.com/@shop.official")) return new Response(shop);
      return new Response("not found", { status: 404 });
    }));
    expect(await runNextSearch(db)).toBe(true);
    const [done] = await db.select().from(searches).where(eq(searches.id, s.id));
    expect(done.status).toBe("done");
    expect(done.stats.costUsd ?? 0).toBe(0);
    const tt = await db.select().from(creators).where(eq(creators.platform, "tiktok"));
    const a = tt.find((c) => c.username === "anna.ugc")!;
    expect([a.followers, a.postsCount, a.bio?.startsWith("UGC creator")]).toEqual([12500, 84, true]);
    // 420000 вподобань / 84 ролики / 12500 підписників = 0,4 — середнє за весь час.
    expect(a.erLikes).toBe(0.4);
    expect((a.metrics as { lifetime?: boolean }).lifetime).toBe(true);
    expect(a.emails).toContain("anna.ugc@gmail.com");
    const cands = await db.select({ username: creators.username, stage: searchCandidates.stage, source: searchCandidates.source })
      .from(searchCandidates).innerJoin(creators, eq(creators.id, searchCandidates.creatorId)).where(eq(searchCandidates.searchId, s.id));
    expect(cands.find((c) => c.username === "anna.ugc")).toMatchObject({ source: "TikTok авторів з бази Instagram" });
    expect(cands.find((c) => c.username === "shop.official")?.stage).not.toBe("qualified");
  });
});

describe("deliverability", () => {
  it("warm-up starts at 5 a day and adds 2 daily up to the limit", () => {
    const now = new Date("2026-11-13T12:00:00Z");
    const mb = { dailyLimit: 30, warmup: true };
    expect(effectiveLimit(mb, null, now)).toBe(5);
    expect(effectiveLimit(mb, new Date("2026-11-06T12:00:00Z"), now)).toBe(19);
    expect(effectiveLimit(mb, new Date("2026-10-01T12:00:00Z"), now)).toBe(30);
    expect(effectiveLimit({ dailyLimit: 30, warmup: false }, null, now)).toBe(30);
  });
  it("pauses a mailbox above 5% bounces (from 10 sent) or after 3 send failures", () => {
    const h = { sent24h: 0, limit: 30, sent7d: 40, bounced7d: 3, bounceRate: 3 / 40, failed7d: 0 };
    expect(pauseReason(h)).toMatch(/^недоставлених листів 8%/);
    expect(pauseReason({ ...h, bounced7d: 2, bounceRate: 2 / 40 })).toBeNull();
    expect(pauseReason({ ...h, sent7d: 8, bounced7d: 2, bounceRate: 0.25 })).toBeNull();
    expect(pauseReason({ ...h, bounced7d: 0, bounceRate: 0, failed7d: 3 })).toMatch(/помилки надсилання/);
  });
  it("checks SPF, DKIM and DMARC of the sender domain", async () => {
    const records: Record<string, string[][]> = {
      "glowlab.com": [["v=spf1 include:_spf.google.com ~all"]],
      "_dmarc.glowlab.com": [["v=DMARC1; p=none"]],
      "google._domainkey.glowlab.com": [["v=DKIM1; k=rsa; p=MIGf"]],
    };
    const resolve = async (name: string) => {
      if (!records[name]) throw Object.assign(new Error("ENODATA"), { code: "ENODATA" });
      return records[name];
    };
    expect(await checkDomain("team@glowlab.com", resolve)).toMatchObject({ spf: "v=spf1 include:_spf.google.com ~all", dmarc: "v=DMARC1; p=none", dkimSelector: "google", warnings: [] });
    records["bare.com"] = [["google-site-verification=x"]];
    const bare = await checkDomain("team@bare.com", resolve);
    expect(bare.warnings).toHaveLength(3);
    // DNS недоступний — не вигадуємо «немає SPF», а кажемо, що перевірити не вдалося.
    const offline = await checkDomain("team@offline.com", async () => { throw Object.assign(new Error("x"), { code: "ECONNREFUSED" }); });
    expect(offline.warnings).toEqual(["Не вдалося перевірити DNS домену (ECONNREFUSED) — натисніть «Перевірити» пізніше"]);
    expect((await checkDomain("me@gmail.com", resolve)).freemail).toBe(true);
  });

  it("verifies an address with the first service that has a key, and caches the verdict", async () => {
    const db = await testDb();
    expect(await verifyEmail(db, "a@b.com")).toBeNull(); // жодного сервісу — лишається MX-перевірка
    await addTestKey(db, "zerobounce", "zb");
    const fetchMock = vi.fn(async () => Response.json({ status: "invalid" }));
    vi.stubGlobal("fetch", fetchMock);
    const [c] = await db.insert(creators).values({ platform: "instagram", username: "x" }).returning();
    await db.insert(creatorContacts).values({ creatorId: c.id, email: "nobody@b.com", status: "personal", confidence: 0.8, source: "bio", sourceUrl: "x" });
    expect(await verifiedVerdict(db, c.id, "nobody@b.com")).toEqual({ verdict: "invalid", service: "zerobounce" });
    expect(await verifiedVerdict(db, c.id, "nobody@b.com")).toEqual({ verdict: "invalid", service: "zerobounce" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rotation picks the mailbox with the most free quota and skips paused ones; bounces pause a mailbox", async () => {
    const db = await testDb();
    const box = (email: string, extra = {}) => db.insert(mailboxes).values({ email, smtpHost: "s", imapHost: "i", username: email, passwordEnc: encryptSecret("x"), dailyLimit: 30, warmup: false, ...extra }).returning().then((r) => r[0]);
    const a = await box("a@x.com");
    const b = await box("b@x.com");
    const p = await box("p@x.com", { pausedAt: new Date(), pausedReason: "test" });
    const [cl] = await db.insert(clients).values({ name: "C", policy: DEFAULT_POLICY, mailboxId: a.id, mailboxPool: [b.id, p.id] }).returning();
    const [c] = await db.insert(creators).values({ platform: "instagram", username: "y" }).returning();
    const [t] = await db.insert(outreachThreads).values({ creatorId: c.id, clientId: cl.id, mailboxId: a.id, toEmail: "y@y.com", subject: "s" }).returning();
    const now = new Date();
    await db.insert(outreachMessages).values(Array.from({ length: 12 }, () => ({ threadId: t.id, mailboxId: a.id, direction: "out" as const, kind: "first" as const, status: "sent" as const, subject: "s", body: "b", sentAt: now })));
    expect(await pickMailbox(db, [a.id, b.id, p.id])).toBe(b.id);
    await db.insert(outreachMessages).values(Array.from({ length: 2 }, (_, i) => ({ threadId: t.id, mailboxId: a.id, direction: "in" as const, kind: "inbound" as const, status: "received" as const, subject: "bounce", body: "x", messageId: `<b${i}@x>`, ai: { processed: true, bounce: true } })));
    expect(await guardMailbox(db, a)).toMatch(/недоставлених листів 17%/);
    const [after] = await db.select().from(mailboxes).where(eq(mailboxes.id, a.id));
    expect(after.pausedAt).not.toBeNull();
    expect(await pickMailbox(db, [a.id, p.id])).toBeNull();
  });
});

describe("profitability", () => {
  it("counts billing months from the start date", () => {
    expect(billingMonths(new Date("2026-09-15"), new Date("2026-11-13"))).toBe(2);
    expect(billingMonths(new Date("2026-09-15"), new Date("2026-11-15"))).toBe(3);
    expect(billingMonths(new Date("2026-12-01"), new Date("2026-11-13"))).toBe(0);
  });
  it("revenue minus your costs, per hour of your time", () => {
    const p = profitability({
      billing: { model: "both", retainerUsd: 800, perPostUsd: 20, creatorFeesBy: "me", productBy: "brand" },
      since: new Date("2026-10-01"), now: new Date("2026-11-13"), posted: 10, shipped: 12, apifyUsd: 6.5, feesUsd: 300, productValueUsd: 45, minutes: 1200,
    });
    expect(p).toMatchObject({ months: 2, revenue: 1800, apifyUsd: 6.5, feesUsd: 300, productUsd: 0, costs: 306.5, net: 1493.5, hours: 20, perHour: 74.68 });
  });
  it("reads it from the client's threads, searches and time log", async () => {
    const db = await testDb();
    const [cl] = await db.insert(clients).values({ name: "C", policy: { ...DEFAULT_POLICY, productValueUsd: 40 }, billing: { model: "per_post", perPostUsd: 50, productBy: "me", startedAt: "2026-11-01" } }).returning();
    await db.insert(searches).values({ name: "s", hashtags: ["x"], clientId: cl.id, stats: { costUsd: 2 } });
    const [c] = await db.insert(creators).values({ platform: "instagram", username: "z" }).returning();
    await db.insert(outreachThreads).values({ creatorId: c.id, clientId: cl.id, toEmail: "z@z.com", subject: "s", status: "posted", terms: { feeUsd: 100, barter: true, deliverables: "", deadlineDays: 14 } });
    await db.insert(timeEntries).values({ clientId: cl.id, day: "2026-11-10", minutes: 90 });
    const p = await clientProfit(db, cl.id, new Date("2026-11-13"));
    expect(p).toMatchObject({ revenue: 50, apifyUsd: 2, feesUsd: 0, productUsd: 40, net: 8, hours: 1.5, perHour: 5.33 });
  });
});

describe("backup", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "parsing-backup-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  it("round-trips the database into an empty one, keeping dates and id counters", async () => {
    const db = await testDb();
    const [c] = await db.insert(creators).values({ platform: "instagram", username: "anna", followers: 5200, lastPostAt: new Date("2026-11-01T10:00:00Z"), emails: ["a@b.com"] }).returning();
    const [cl] = await db.insert(clients).values({ name: "Glow", policy: DEFAULT_POLICY }).returning();
    await db.insert(outreachThreads).values({ creatorId: c.id, clientId: cl.id, toEmail: "a@b.com", subject: "Hi", status: "sent" });
    const r = await backupDatabase(db, dir, new Date("2026-11-13T08:00:00Z"));
    expect(path.basename(r.file)).toBe("parsing-2026-11-13.jsonl.gz");

    const fresh = await testDb();
    const counts = await restoreBackup(fresh, r.file);
    expect(counts).toMatchObject({ creators: 1, clients: 1, outreach_threads: 1 });
    const [back] = await fresh.select().from(creators);
    expect(back.lastPostAt?.toISOString()).toBe("2026-11-01T10:00:00.000Z");
    expect(back.emails).toEqual(["a@b.com"]);
    const [next] = await fresh.insert(creators).values({ platform: "instagram", username: "new" }).returning();
    expect(next.id).toBeGreaterThan(c.id);
    // Повторне відновлення в непорожню базу — відмова без --force.
    await expect(restoreBackup(fresh, r.file)).rejects.toThrow(/вже є дані/);
  });
});
