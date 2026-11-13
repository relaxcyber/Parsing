import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { creators, jobPitches, searchCandidates, searches } from "@/db/schema";
import {
  checkProposal, codeRedFlags, expandCounts, queuePitches, runPitchQueue, splitJobs, tidy, createPitch, groundJob, JobSchema, jobFit, proposalFacts, rewritePitch, sampleList, sampleWhy, shortCount,
} from "@/pitch";
import { addTestKey, testDb } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const JOB = `UGC creator sourcing for a skincare brand
We are a US skincare brand and need someone to find 30 UGC creators on Instagram who make honest product reviews.
Creators must be based in the US and have 5k-50k followers. Please include engagement rate.
Budget: $150 fixed price. Deadline 5 days.`;

const profile = { name: "Yevhen", about: "I find and vet creators with my own tool.", offer: "30 vetted creators in 48 hours." };

const raw = (over: Record<string, unknown> = {}) => JobSchema.parse({
  title: "UGC sourcing for skincare", summary_uk: "Потрібно знайти 30 UGC-авторів у США.", job_type: "find_creators", platform: "instagram", focus: "ugc",
  niche: "skincare", creators_needed: { value: 30, quote: "find 30 UGC creators" }, followers: { min: 5000, max: 50000, quote: "have 5k-50k followers" }, budget: { amount: 150, kind: "fixed", quote: "Budget: $150 fixed price" },
  requirements: [{ text: "US-based creators", quote: "must be based in the US" }, { text: "Long-term contract", quote: "6 month retainer" }],
  red_flags: [], questions: ["Do you have a list of competitors you like?"], ...over,
});

describe("job analysis grounding", () => {
  it("keeps numbers and requirements only with a verbatim quote that holds the number", () => {
    const a = groundJob(raw(), JOB);
    expect(a.creatorsNeeded).toEqual({ count: 30, quote: "find 30 UGC creators" });
    expect(a.budget).toMatchObject({ amount: 150, kind: "fixed" });
    expect(a.requirements.map((r) => r.text)).toEqual(["US-based creators"]);
    expect(a.dropped).toBe(1);
    expect(a.followers).toEqual({ min: 5000, max: 50000, quote: "have 5k-50k followers" });
    expect(groundJob(raw({ followers: { min: 10000, max: 50000, quote: "have 5k-50k followers" } }), JOB).followers).toBeNull();
    expect(expandCounts("10,000 – 1.5M followers, 5k")).toEqual([10000, 1500000, 5000]);
    // Бюджет, якого немає в цитаті, модель «порахувала» сама — відкидаємо.
    expect(groundJob(raw({ budget: { amount: 500, kind: "fixed", quote: "Budget: $150 fixed price" } }), JOB).budget).toBeNull();
  });
  it("code finds off-platform and unpaid-test flags by itself", () => {
    const flags = codeRedFlags("Message me on WhatsApp +1 555 0100 to discuss. First a free test of 10 creators.");
    expect(flags.map((f) => f.text).join(" ")).toMatch(/месенджер.*Безкоштовне/s);
    expect(codeRedFlags(JOB)).toEqual([]);
  });
  it("code decides whether the job is worth a proposal", () => {
    expect(jobFit(groundJob(raw(), JOB)).level).toBe("good");
    expect(jobFit(groundJob(raw({ job_type: "be_a_creator" }), JOB)).level).toBe("skip");
    expect(jobFit(groundJob(raw({ budget: { amount: 15, kind: "fixed", quote: "find 30 UGC creators" } }), "find 30 UGC creators for $15")).level).toBe("good");
    const cheap = groundJob(raw({ budget: { amount: 15, kind: "fixed", quote: "only $15" } }), `${JOB}\nonly $15`);
    expect(jobFit(cheap)).toMatchObject({ level: "maybe" });
    const scam = groundJob(raw(), `${JOB}\nYou need to pay a deposit to start working with us.`);
    expect(jobFit(scam).level).toBe("skip");
  });
});

describe("proposal checks", () => {
  const sample = { creatorId: 1, handle: "glowbyanna", platform: "instagram", url: "https://www.instagram.com/glowbyanna/", followers: 23400, followersShort: "23K", erPct: "4.2%", country: "US", hasEmail: true, why: "UGC creator" };
  const facts = proposalFacts(groundJob(raw(), JOB), profile, [sample]);
  it("passes a proposal built from facts", () => {
    const body = "You need 30 US-based UGC creators for your skincare brand. I find and vet creators with my own tool and can deliver 30 vetted creators in 48 hours.\nI already found a few in your niche:\n- @glowbyanna (https://www.instagram.com/glowbyanna/) — 23K followers, 4.2% engagement\nDo you have a list of competitors you like?\nYevhen";
    expect(checkProposal(body, facts, JOB)).toEqual([]);
  });
  it("flags invented numbers, handles, emails and missing samples", () => {
    const body = "I have 5 years of experience and 120 happy clients. See @madeupcreator or write me at me@mail.com. Engagement: null. Yevhen";
    const issues = checkProposal(body, facts, JOB).join(" | ");
    expect(issues).toMatch(/«120»/);
    expect(issues).toMatch(/@madeupcreator/);
    expect(issues).toMatch(/email/);
    expect(issues).toMatch(/null/);
    expect(issues).toMatch(/немає прикладу @glowbyanna/);
  });
  it("sample reasons go out in English and never carry an email", () => {
    expect(sampleWhy(["називає себе UGC-креатором", "відкритий до співпраці («Collabs: a@b.com»)", "ніша: skincare, beauty", "є email"]))
      .toBe("UGC creator, open to collabs, niche: skincare, beauty");
    expect(shortCount(23_400)).toBe("23K");
    expect(shortCount(1_250_000)).toBe("1.3M");
    expect(sampleList([sample])).not.toMatch(/@\w+\.\w+/);
    expect(tidy("I found: - @a (x) — 5K - @b (y) — 6K\n\n\n\nYevhen")).toBe("I found:\n- @a (x) — 5K\n- @b (y) — 6K\n\nYevhen");
  });
});

function fakeLlm(calls: string[]) {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const system: string = body.messages[0].content;
    const user: string = body.messages[1].content;
    let out: unknown;
    if (system.startsWith("You read a freelance job")) {
      calls.push("job");
      out = {
        title: "UGC sourcing for skincare", summary_uk: "Потрібно знайти 30 UGC-авторів у США.", job_type: "find_creators", platform: "instagram", focus: "ugc", niche: "skincare",
        creators_needed: { value: 30, quote: "find 30 UGC creators" }, budget: { amount: 150, kind: "fixed", quote: "Budget: $150 fixed price" },
        followers: { min: 5000, max: 50000, quote: "5k-50k followers" }, requirements: [{ text: "US-based creators", quote: "must be based in the US" }], red_flags: [], questions: ["Do you have a list of competitors you like?"],
      };
    } else if (system.startsWith("You help a creator-sourcing")) {
      calls.push("brief");
      out = { hashtags: ["skincareugc", "ugccreator"], keywords: ["skincare"], stop_words: [], bio_queries: ["ugc creator skincare"], competitors: [], countries: ["US"], languages: ["en"], formats: [], notes: "" };
    } else {
      calls.push("proposal");
      const facts = JSON.parse(user.slice(user.indexOf("{"), user.indexOf("\n\n<data")));
      const lines = facts.samples.map((s: any) => `- ${s.handle} (${s.url}) — ${s.followers} followers`).join("\n");
      out = {
        proposal: `You need 30 US-based UGC creators for skincare. I can deliver 30 vetted creators in 48 hours.${lines ? `\nI already found a few in your niche:\n${lines}` : ""}\nYevhen`,
        translation_uk: "Вам потрібно 30 авторів…",
      };
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify(out) } }] });
  }));
}

describe("job pitch end to end", () => {
  it("analyses the job, queues a small sample search, writes a proposal, then rewrites it with the best creators", async () => {
    const db = await testDb();
    await addTestKey(db, "groq", "gq");
    const calls: string[] = [];
    fakeLlm(calls);
    const { id, notes } = await createPitch(db, { jobText: JOB, profile });
    expect(notes).toEqual([]);
    const [p] = await db.select().from(jobPitches).where(eq(jobPitches.id, id));
    expect(p.analysis).toMatchObject({ jobType: "find_creators", budget: { amount: 150 } });
    expect(p.issues).toEqual([]);
    expect(p.proposal).toMatch(/^You need 30/);
    const [s] = await db.select().from(searches).where(eq(searches.id, p.searchId!));
    expect(s).toMatchObject({ platform: "instagram", status: "queued", targetLeads: 5, maxProfiles: 40, budgetUsd: 3, hashtags: ["skincareugc", "ugccreator"], countries: ["US"], minFollowers: 5000, maxFollowers: 50000 });

    // Пошук знайшов авторів: найкращі (спершу ліди) потрапляють у відгук, без email.
    const made = await db.insert(creators).values([1, 2, 3, 4, 5, 6, 7].map((i) => ({
      platform: "instagram", externalId: `x${i}`, username: `creator${i}`, followers: i === 3 ? 500 : 10_000 * i, erLikes: 0.03, emails: [`c${i}@mail.com`],
    }))).returning({ id: creators.id });
    await db.insert(searchCandidates).values(made.map((c, i) => ({
      searchId: s.id, creatorId: c.id, stage: "qualified" as const, score: 50 + i, lead: i < 2, reasons: ["називає себе UGC-креатором"],
    })));
    await db.update(searches).set({ status: "done" }).where(eq(searches.id, s.id));
    const r = await rewritePitch(db, p);
    expect(r).toEqual({ issues: [], samples: 5 });
    const [after] = await db.select().from(jobPitches).where(eq(jobPitches.id, id));
    // Ліди першими; 60K і 70K — поза діапазоном замовника, тож поступаються іншим; 500 підписників — не приклад.
    expect(after.samples.map((x) => x.handle)).toEqual(["creator2", "creator1", "creator5", "creator4", "creator7"]);
    expect(after.proposal).toMatch(/@creator2/);
    expect(after.proposal).not.toMatch(/mail\.com/);
    // Без авторів — порожній список.
    expect(await rewritePitch(db, after, [])).toEqual({ issues: [], samples: 0 });
    expect(calls).toEqual(["job", "brief", "proposal", "proposal", "proposal"]);
  });

  it("does not search for a job that wants a creator to film content", async () => {
    const db = await testDb();
    await addTestKey(db, "groq", "gq");
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: any) => {
      const system: string = JSON.parse(init.body).messages[0].content;
      const out = system.startsWith("You read a freelance job")
        ? { title: "UGC video", job_type: "be_a_creator", platform: "tiktok", questions: [] }
        : { proposal: "You need a UGC video. I can find creators who film it for you. Yevhen", translation_uk: "" };
      return Response.json({ choices: [{ message: { content: JSON.stringify(out) } }] });
    }));
    const { id } = await createPitch(db, { jobText: "Looking for a UGC creator to film 3 TikTok videos for our coffee brand. Send your portfolio.", profile });
    const [p] = await db.select().from(jobPitches).where(eq(jobPitches.id, id));
    expect(p.searchId).toBeNull();
    expect(jobFit(p.analysis!).level).toBe("skip");
  });
});

describe("several jobs at once", () => {
  it("splits by --- and the worker analyses them one by one; only good-fit jobs get a sample search", async () => {
    const db = await testDb();
    await addTestKey(db, "groq", "gq");
    const calls: string[] = [];
    fakeLlm(calls);
    const second = "Looking for a UGC creator to film 3 TikTok videos for our coffee brand. Send your portfolio and rates please, thanks a lot.";
    const jobs = splitJobs(`${JOB}\n---\n${second}\n===\ntoo short`);
    expect(jobs).toHaveLength(2);
    expect(await queuePitches(db, jobs, profile, { platform: "auto", search: true })).toBe(2);
    expect(await runPitchQueue(db)).toBe(true);
    const [first] = await db.select().from(jobPitches).orderBy(jobPitches.id).limit(1);
    expect(first.analysis?.jobType).toBe("find_creators");
    expect(first.searchId).not.toBeNull();
    expect(first.proposal).toMatch(/^You need 30/);
    expect(await runPitchQueue(db)).toBe(true);
    expect(await runPitchQueue(db)).toBe(false);
  });
});
