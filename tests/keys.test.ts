import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { apiKeys, usageEvents } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/keys/crypto";
import { syncKeyQuota } from "@/keys/quota-sync";
import { acquireKey, keyState, NoKeyAvailableError, ProviderHttpError, reportResult, withKey } from "@/keys/router";
import { ContentItemSchema } from "@/core/contract";
import { addTestKey, testDb } from "./helpers";

const getKey = async (db: any, id: number) => (await db.select().from(apiKeys).where(eq(apiKeys.id, id)))[0];

describe("crypto", () => {
  it("round-trips and rejects tampering", () => {
    const enc = encryptSecret("sk-secret-value");
    expect(enc).not.toContain("sk-secret");
    expect(decryptSecret(enc)).toBe("sk-secret-value");
    const parts = enc.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(parts.join("."))).toThrow();
  });
});

describe("router", () => {
  it("prefers the key with the largest free share", async () => {
    const db = await testDb();
    await addTestKey(db, "apify", "A", { quotaLimit: 100, quotaUsed: 80 });
    await addTestKey(db, "apify", "B", { quotaLimit: 100, quotaUsed: 10 });
    expect((await acquireKey(db, "apify")).secret).toBe("B");
  });

  it("skips exhausted, disabled and other providers' keys", async () => {
    const db = await testDb();
    await addTestKey(db, "apify", "full", { quotaLimit: 5, quotaUsed: 5 });
    await addTestKey(db, "apify", "off", { status: "disabled" });
    await addTestKey(db, "groq", "other");
    await expect(acquireKey(db, "apify")).rejects.toBeInstanceOf(NoKeyAvailableError);
  });

  it("resets usage when the period rolls over", async () => {
    const db = await testDb();
    const k = await addTestKey(db, "groq", "daily", {
      quotaLimit: 5, quotaUsed: 5, quotaPeriod: "day", periodStartedAt: new Date("2026-01-01T10:00:00Z"),
    });
    await expect(acquireKey(db, "groq", { now: new Date("2026-01-01T23:00:00Z") })).rejects.toThrow();
    const now = new Date("2026-01-02T00:05:00Z");
    expect((await acquireKey(db, "groq", { now })).id).toBe(k.id);
    await reportResult(db, k.id, { ok: true, now });
    const after = await getKey(db, k.id);
    expect(after.quotaUsed).toBe(1);
    expect(after.periodStartedAt.toISOString()).toBe("2026-01-02T00:00:00.000Z");
  });

  it("rotates on 429 and puts the key on cooldown", async () => {
    const db = await testDb();
    const a = await addTestKey(db, "firecrawl", "A", { quotaLimit: 100 });
    await addTestKey(db, "firecrawl", "B", { quotaLimit: 100, quotaUsed: 50 });
    const seen: string[] = [];
    const out = await withKey(db, "firecrawl", async (key, usage) => {
      seen.push(key.secret);
      if (key.secret === "A") throw new ProviderHttpError(429, "rate limited", 120);
      usage.units = 3;
      return "done";
    });
    expect(out).toBe("done");
    expect(seen).toEqual(["A", "B"]);
    const aAfter = await getKey(db, a.id);
    expect(keyState(aAfter, new Date())).toBe("cooldown");
    expect(aAfter.quotaUsed).toBe(0);
    expect(await db.select().from(usageEvents)).toHaveLength(2);
    expect((await acquireKey(db, "firecrawl")).secret).toBe("B");
  });

  it("marks a key invalid on 401 and does not rotate on other errors", async () => {
    const db = await testDb();
    const a = await addTestKey(db, "groq", "A");
    await expect(withKey(db, "groq", async () => { throw new ProviderHttpError(401); })).rejects.toThrow();
    expect((await getKey(db, a.id)).status).toBe("invalid");

    const b = await addTestKey(db, "mistral", "B");
    await addTestKey(db, "mistral", "C");
    let calls = 0;
    await expect(withKey(db, "mistral", async () => { calls++; throw new ProviderHttpError(500); })).rejects.toThrow();
    expect(calls).toBe(1);
    expect((await getKey(db, b.id)).status).toBe("active");
  });
});

describe("quota sync", () => {
  it("stores the limit reported by Apify", async () => {
    const db = await testDb();
    const k = await addTestKey(db, "apify", "tok");
    const fake = (async (url: string, init: any) => {
      expect(url).toContain("/users/me/limits");
      expect(init.headers.Authorization).toBe("Bearer tok");
      return new Response(JSON.stringify({ data: { limits: { maxMonthlyUsageUsd: 5 }, current: { monthlyUsageUsd: 1.25 } } }));
    }) as unknown as typeof fetch;
    expect((await syncKeyQuota(db, k.id, fake)).ok).toBe(true);
    const after = await getKey(db, k.id);
    expect([after.quotaLimit, after.quotaUsed, after.quotaUnit]).toEqual([5, 1.25, "usd"]);
  });

  it("marks the key invalid when the provider rejects it", async () => {
    const db = await testDb();
    const k = await addTestKey(db, "openrouter", "bad");
    const fake = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    expect((await syncKeyQuota(db, k.id, fake)).ok).toBe(false);
    expect((await getKey(db, k.id)).status).toBe("invalid");
  });
});

describe("contract", () => {
  it("accepts a Reddit comment and applies defaults", () => {
    const item = ContentItemSchema.parse({
      id: "t1_abc", source: "reddit", kind: "comment", url: "https://reddit.com/r/UGCcreators/comments/x/y/abc",
      author: { username: "maker" }, text: "portfolio inside", thread: { parentId: "t3_x", rootId: "t3_x", depth: 1 },
      fetchedAt: "2026-11-09T10:00:00Z", via: "reddit-api",
    });
    expect(item.media).toEqual([]);
    expect(item.fetchedAt).toBeInstanceOf(Date);
  });
  it("rejects an unknown source and a bad URL", () => {
    const base = { id: "1", kind: "post", fetchedAt: new Date(), via: "local" };
    expect(() => ContentItemSchema.parse({ ...base, source: "myspace", url: "https://a.b" })).toThrow();
    expect(() => ContentItemSchema.parse({ ...base, source: "web", url: "not a url" })).toThrow();
  });
});

describe("key import", () => {
  it("adds keys, skips duplicates and reports bad lines", async () => {
    const { importKeys } = await import("@/keys/import");
    const db = await testDb();
    const text = ["# comment", "", "groq | аудит | gsk_aaaaaaaaaaaa", "Groq | листи | gsk_bbbbbbbbbbbb | 1000 | requests | day",
      "groq | повтор | gsk_aaaaaaaaaaaa", "nope | x | y", "mistral | без ключа"].join("\n");
    const report = await importKeys(db, text);
    expect(report).toHaveLength(5);
    expect(report[2]).toContain("уже додано");
    expect(report[3]).toContain("невідомий провайдер");
    expect(report[4]).toContain("потрібні назва і ключ");
    const rows = await db.select().from(apiKeys);
    expect(rows.map((r) => [r.label, r.quotaLimit, r.quotaPeriod])).toEqual([["аудит", null, "day"], ["листи", 1000, "day"]]);
    expect(decryptSecret(rows[1].secretEnc)).toBe("gsk_bbbbbbbbbbbb");
  });
});
