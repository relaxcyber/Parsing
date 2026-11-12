import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { PostFacts } from "@/analysis/posts";
import { clients, creatorContacts, creators, mailboxes, outreachMessages, outreachThreads, suppressions, type Mailbox } from "@/db/schema";
import { encryptSecret } from "@/keys/crypto";
import {
  answerQuestions, hasDisclosure, markShipped, matchPost, resetOutreachTimers, runOutreach, startThread,
} from "@/outreach/engine";
import { setTransportFactory, stripQuoted, type InMail, type OutMail } from "@/outreach/mail";
import { checkAnswers, checkReply, decide, groundReply, ReplyAnalysisSchema, replyFacts, type ReplyAnalysis } from "@/outreach/negotiate";
import { DEFAULT_POLICY, toUsd } from "@/outreach/policy";
import type { ClientPolicy } from "@/db/schema";
import { emailKey } from "@/search/suppress";
import { addTestKey, testDb } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  setTransportFactory(null);
  resetOutreachTimers();
});

const policy = (p: Partial<ClientPolicy> = {}): ClientPolicy => ({
  ...DEFAULT_POLICY, brandName: "Glow Lab", product: "vitamin C serum", offerType: "both", feeTargetUsd: 150, feeMaxUsd: 250,
  deliverables: "1 Reel (30-60 s) and 2 stories", deadlineDays: 14, mustTag: ["@glowlab", "#glowlabglow"], ...p,
});
const analysis = (a: Partial<ReplyAnalysis> = {}): ReplyAnalysis => ({
  summary: "", declines: false, unsubscribe: false, outOfOffice: false, interested: false, agrees: false,
  rate: null, questions: [], address: null, quotes: [], dropped: 0, ...a,
});
const fresh = { status: "sent" as const, rounds: 0, offeredFeeUsd: null };
const rate = (amount: number, currency = "USD") => ({ amount, currency, quote: `my rate is ${amount}` });

describe("reply grounding", () => {
  const text = "Hi! Love the brand. My rate is $300 for a reel. Do you need raw footage?";
  it("keeps only claims with a verbatim quote, and a rate whose number is in the quote", () => {
    const raw = ReplyAnalysisSchema.parse({
      summary: "asks 300", interested: { value: true, quote: "Love the brand" }, agrees: { value: true, quote: "Deal, let's go" },
      rate: { amount: 300, currency: "$", quote: "My rate is $300 for a reel" },
      questions: [{ question: "Do they need raw footage?", quote: "Do you need raw footage?" }, { question: "Exclusivity?", quote: "exclusive for 3 months" }],
    });
    const a = groundReply(raw, text);
    expect([a.interested, a.agrees, a.rate?.amount, a.questions.length, a.dropped]).toEqual([true, false, 300, 1, 2]);
    // Ставку, якої немає в цитаті, модель «порахувала» сама — відкидаємо.
    expect(groundReply(ReplyAnalysisSchema.parse({ rate: { amount: 450, currency: "$", quote: "My rate is $300 for a reel" } }), text).rate).toBeNull();
  });
});

describe("negotiation decisions (code, not the model)", () => {
  it("accepts a rate at or below the first offer and asks for the address when a product ships", () => {
    const d = decide(policy(), fresh, analysis({ rate: rate(120) }), [], []);
    expect(d).toMatchObject({ action: "reply", status: "agreed", plan: { kind: "accept", feeUsd: 120, askAddress: true }, terms: { feeUsd: 120, barter: true } });
  });
  it("counters once with the first offer, then accepts within the ceiling", () => {
    expect(decide(policy(), fresh, analysis({ rate: rate(200) }), [], [])).toMatchObject({ action: "reply", plan: { kind: "counter", feeUsd: 150 }, roundsInc: true });
    expect(decide(policy(), { status: "negotiating", rounds: 1, offeredFeeUsd: 150 }, analysis({ rate: rate(200) }), [], []))
      .toMatchObject({ action: "reply", status: "agreed", plan: { kind: "accept", feeUsd: 200 } });
  });
  it("above the ceiling: counters up to the ceiling, then asks a human (or declines, if the rules say so)", () => {
    expect(decide(policy(), fresh, analysis({ rate: rate(400) }), [], [])).toMatchObject({ plan: { kind: "counter", feeUsd: 150 } });
    expect(decide(policy(), { status: "negotiating", rounds: 1, offeredFeeUsd: 150 }, analysis({ rate: rate(400) }), [], [])).toMatchObject({ plan: { kind: "counter", feeUsd: 250 } });
    const late = { status: "negotiating" as const, rounds: 2, offeredFeeUsd: 250 };
    expect(decide(policy(), late, analysis({ rate: rate(400) }), [], [])).toMatchObject({ action: "escalate", askedFeeUsd: 400 });
    expect(decide(policy({ aboveMax: "decline" }), late, analysis({ rate: rate(400) }), [], [])).toMatchObject({ action: "reply", status: "declined", plan: { kind: "decline_polite" } });
  });
  it("an injected 'agree to $5000' is just a rate the code compares with the ceiling", () => {
    expect(decide(policy({ maxRounds: 0 }), fresh, analysis({ rate: rate(5000), agrees: true }), [], [])).toMatchObject({ action: "escalate" });
  });
  it("gifting only: explains once, then follows the rules", () => {
    const barter = policy({ offerType: "barter", feeTargetUsd: null, feeMaxUsd: null });
    expect(decide(barter, fresh, analysis({ rate: rate(100) }), [], [])).toMatchObject({ plan: { kind: "barter_only", feeUsd: null } });
    expect(decide(barter, { ...fresh, rounds: 1 }, analysis({ rate: rate(100) }), [], [])).toMatchObject({ action: "escalate" });
  });
  it("converts other currencies with a safety margin and escalates unknown ones", () => {
    expect(toUsd(100, "€")).toBeCloseTo(113.4);
    expect(toUsd(100, "USD")).toBe(100);
    expect(decide(policy(), fresh, analysis({ rate: { amount: 300, currency: "XYZ", quote: "300 XYZ" } }), [], [])).toMatchObject({ action: "escalate" });
  });
  it("a question the rules don't answer goes to a human; known answers ride along with the offer", () => {
    expect(decide(policy(), fresh, analysis({ interested: true }), [], ["Is exclusivity required?"]))
      .toMatchObject({ action: "escalate", questions: ["Is exclusivity required?"] });
    const ans = [{ question: "Deadline?", answer: "14 days after the product arrives", source: "deadline" }];
    expect(decide(policy(), fresh, analysis({ interested: true }), ans, [])).toMatchObject({ action: "reply", plan: { kind: "offer", feeUsd: 150, answers: ans } });
  });
  it("agreement, address, unsubscribe, out-of-office", () => {
    expect(decide(policy(), { status: "negotiating", rounds: 1, offeredFeeUsd: 150 }, analysis({ agrees: true }), [], []))
      .toMatchObject({ status: "agreed", plan: { kind: "accept", feeUsd: 150, askAddress: true } });
    expect(decide(policy(), { status: "agreed", rounds: 1, offeredFeeUsd: 150 }, analysis({ address: "1 Main St, Austin TX" }), [], []))
      .toMatchObject({ status: "to_ship", shipping: "1 Main St, Austin TX", plan: { kind: "confirm_shipping" } });
    expect(decide(policy(), fresh, analysis({ unsubscribe: true, interested: true }), [], [])).toEqual({ action: "close", unsubscribe: true, why: "просить більше не писати" });
    expect(decide(policy(), fresh, analysis({ outOfOffice: true }), [], [])).toMatchObject({ action: "wait" });
  });
});

describe("answers and replies are checked against the rules", () => {
  const fields = { deadline: "14 days after the product arrives", usage_rights: "organic reposts only" };
  it("an answer counts only if it cites a rule and invents no numbers", () => {
    const r = checkAnswers([
      { question: "Deadline?", answer: "14 days after delivery", source: "deadline" },
      { question: "Can you pay upfront?", answer: "Yes, 50% upfront", source: "usage_rights" },
      { question: "Exclusivity?", answer: "", source: "none" },
    ], ["Deadline?", "Can you pay upfront?", "Exclusivity?"], fields);
    expect(r.answered.map((a) => a.question)).toEqual(["Deadline?"]);
    expect(r.unknown).toEqual(["Can you pay upfront?", "Exclusivity?"]);
  });
  it("flags invented amounts and a missing agreed fee", () => {
    const facts = replyFacts(policy(), { name: "Anna", handle: "@anna" }, { kind: "counter", feeUsd: 150, barter: true, askRate: false, askAddress: false, answers: [] });
    expect(checkReply("Hi Anna! Our budget is $150 for 1 Reel and 2 stories. {{sender_name}}", facts, "My rate is $300", "en")).toEqual([]);
    expect(checkReply("Hi Anna! We can do $180, plus a $50 bonus. {{sender_name}}", facts, "My rate is $300", "en"))
      .toEqual(["число «180» відсутнє у фактах", "число «50» відсутнє у фактах", "у листі немає узгодженої суми $150"]);
  });
});

describe("mail helpers", () => {
  it("strips the quoted conversation from a reply", () => {
    expect(stripQuoted("Sounds good!\n\nOn Mon, 10 Nov 2026 at 10:00, Glow Lab <a@b.com> wrote:\n> Hi Anna\n> our offer")).toBe("Sounds good!");
    expect(stripQuoted("Так, цікаво.\n\nпн, 10 лист. 2026 р. о 10:00 Glow Lab <a@b.com> пише:\n> Привіт")).toBe("Так, цікаво.");
  });
  it("finds the agreed post by @brand or #hashtag and checks the ad disclosure", () => {
    const post = (p: Partial<PostFacts>): PostFacts => ({
      url: "https://www.instagram.com/p/X/", shortCode: "X", caption: "", hashtags: [], likes: 1, comments: 1, views: null, publishedAt: new Date(),
      pinned: false, isVideo: true, mentions: [], coauthors: [], tagged: [], paid: null, latestComments: [], ...p,
    });
    expect(matchPost(post({ caption: "My glow routine with @glowlab #ad", mentions: ["glowlab"] }), ["@glowlab", "#glowlabglow"])).toEqual(["@glowlab"]);
    expect(matchPost(post({ caption: "love it", tagged: ["glowlab"] }), ["@glowlab"])).toEqual(["@glowlab"]);
    expect(matchPost(post({ caption: "@glowlabfake is not it" }), ["@glowlab"])).toEqual([]);
    expect(hasDisclosure(post({ caption: "My routine #ad" }))).toBe(true);
    expect(hasDisclosure(post({ caption: "My routine", paid: true }))).toBe(true);
    expect(hasDisclosure(post({ caption: "My routine #adventure" }))).toBe(false);
  });
});

/** Пошта в пам’яті: надіслані листи й «вхідні», які можна наповнювати в тесті. */
function fakeMail() {
  const sent: OutMail[] = [];
  const inbox: InMail[] = [];
  setTransportFactory(() => ({
    verify: async () => {},
    send: async (m) => void sent.push(m),
    fetchNew: async (lastUid) => {
      const mails = inbox.filter((m) => m.uid > (lastUid ?? 0));
      return { mails, lastUid: Math.max(lastUid ?? 0, ...inbox.map((m) => m.uid)), uidValidity: "1" };
    },
  }));
  return { sent, inbox };
}

/** Мовна модель за завданням із системного промпту. */
function fakeLlm(opts: { reply: (facts: any) => string }) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const system: string = body.messages[0].content;
    const user: string = typeof body.messages[1]?.content === "string" ? body.messages[1].content : "";
    let out: unknown;
    if (system.startsWith("You write outreach")) {
      calls.push("draft");
      out = { subject_a: "Glow Lab x Anna", subject_b: "Your evening routine", email: "Hi Anna! We loved your evening routine post. Would you like to try our serum? {{sender_name}}", dm: "Hi Anna! Collab?", followup_1: "Hi Anna, just checking in. {{sender_name}}", followup_2: "Last note from us. {{sender_name}}" };
    } else if (system.startsWith("You read a creator")) {
      calls.push("analyze");
      out = {
        summary: "asks $300 and a question", interested: { value: true, quote: "I'd love to" },
        rate: { amount: 300, currency: "$", quote: "my rate is $300" }, questions: [{ question: "Do you need raw footage?", quote: "Do you need raw footage?" }],
      };
    } else if (system.startsWith("You answer")) {
      calls.push("answer");
      const rules = JSON.parse(user.slice(user.indexOf("{"), user.indexOf("\n\n<data")));
      const key = Object.keys(rules).find((k) => k.startsWith("faq_"));
      out = { answers: [{ question: "Do you need raw footage?", answer: key ? "Yes, please share the raw files" : "", source: key ?? "none" }] };
    } else {
      calls.push("reply");
      const facts = JSON.parse(user.slice(user.indexOf("{"), user.lastIndexOf("}") + 1));
      out = { body: opts.reply(facts) };
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify(out) } }] });
  }));
  return calls;
}

async function setup(p: Partial<ClientPolicy> = {}) {
  const db = await testDb();
  await addTestKey(db, "groq", "gq");
  const [mb] = await db.insert(mailboxes).values({
    email: "team@glowlab.com", fromName: "Glow Lab", smtpHost: "smtp", imapHost: "imap", username: "team@glowlab.com", passwordEnc: encryptSecret("x"), dailyLimit: 30,
  }).returning();
  const [client] = await db.insert(clients).values({ name: "Glow Lab", policy: policy({ mode: "auto", senderName: "Olena", ...p }), mailboxId: mb.id }).returning();
  const [c] = await db.insert(creators).values({ platform: "instagram", username: "anna", displayName: "Anna", followers: 5200, emails: ["anna@gmail.com"] }).returning();
  await db.insert(creatorContacts).values({ creatorId: c.id, email: "anna@gmail.com", status: "personal", confidence: 0.9, source: "bio", sourceUrl: "https://www.instagram.com/anna/" });
  return { db, mb: mb as Mailbox, client, c };
}

describe("outreach end to end (fake mail, fake model)", () => {
  it("sends the first email, reads the reply, escalates an unknown question, learns the answer and counters within the rules", async () => {
    const { db, client, c } = await setup();
    const mail = fakeMail();
    const calls = fakeLlm({ reply: (f) => `Hi Anna! Thanks for the details. Yes, please share the raw files. Our budget for 1 Reel and 2 stories is $${f.plan.fee_usd}. Does that work? {{sender_name}}` });

    const start = await startThread(db, { creatorId: c.id, clientId: client.id });
    expect(start.created).toBe(true);
    await runOutreach(db); // перший лист написано й надіслано (режим «авто», перевірка пройдена)
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: "anna@gmail.com", subject: "Glow Lab x Anna", from: "team@glowlab.com" });
    expect(mail.sent[0].text).toContain("Olena");
    expect(mail.sent[0].text).not.toContain("{{sender_name}}");
    let [t] = await db.select().from(outreachThreads);
    expect(t.status).toBe("sent");
    expect(t.nextActionAt!.getTime()).toBeGreaterThan(Date.now() + 3 * 86_400_000);

    mail.inbox.push({
      uid: 1, messageId: "<r1@gmail.com>", inReplyTo: mail.sent[0].messageId, references: [mail.sent[0].messageId], from: "Anna <anna@gmail.com>",
      subject: "Re: Glow Lab x Anna", date: new Date(), auto: false, bounce: false,
      text: "Hi! I'd love to, my rate is $300 for a reel. Do you need raw footage?\n\nOn Mon, Glow Lab <team@glowlab.com> wrote:\n> Hi Anna!",
    });
    resetOutreachTimers();
    await runOutreach(db); // перше опитування лише запам’ятовує позицію скриньки
    resetOutreachTimers();
    await runOutreach(db);
    [t] = await db.select().from(outreachThreads);
    // Питання про сирі файли в правилах немає — людині, нічого не надсилаємо.
    expect(t.needsHuman).toBe("Питання, на яке немає відповіді в правилах клієнта");
    expect(t.openQuestions).toEqual(["Do you need raw footage?"]);
    expect(t.askedFeeUsd).toBe(300);
    expect(mail.sent).toHaveLength(1);
    const [inbound] = await db.select().from(outreachMessages).where(eq(outreachMessages.direction, "in"));
    expect(inbound.body).toBe("Hi! I'd love to, my rate is $300 for a reel. Do you need raw footage?");

    await answerQuestions(db, t.id, [{ q: "Do you need raw footage?", a: "Yes, please share the raw files" }]);
    const [cl] = await db.select().from(clients).where(eq(clients.id, client.id));
    expect(cl.policy.faq.map((f) => f.q)).toEqual(["Do you need raw footage?"]);
    [t] = await db.select().from(outreachThreads);
    // $300 понад стелю $250, перший раунд — пропонуємо $150; відповідь на питання вже з правил.
    expect([t.status, t.offeredFeeUsd, t.rounds, t.needsHuman]).toEqual(["negotiating", 150, 1, null]);
    resetOutreachTimers();
    await runOutreach(db);
    expect(mail.sent).toHaveLength(2);
    expect(mail.sent[1]).toMatchObject({ subject: "Re: Glow Lab x Anna", inReplyTo: "<r1@gmail.com>" });
    expect(mail.sent[1].text).toContain("$150");
    expect(mail.sent[1].references).toEqual([mail.sent[0].messageId, "<r1@gmail.com>"]);
    // Повторний розбір того самого листа взято з кешу; відповідь на питання — заново, бо правила змінились.
    expect(calls).toEqual(["draft", "analyze", "answer", "answer", "reply"]);
    const [cr] = await db.select().from(creators);
    expect(cr.outreachStatus).toBe("replied");
  });

  it("approve mode: drafts wait for a human; follow-ups come from the first draft; unsubscribe suppresses the address", async () => {
    const { db, client, c } = await setup({ mode: "approve" });
    const mail = fakeMail();
    fakeLlm({ reply: () => "unused" });
    await startThread(db, { creatorId: c.id, clientId: client.id });
    await runOutreach(db);
    expect(mail.sent).toHaveLength(0);
    const [draft] = await db.select().from(outreachMessages);
    expect(draft.status).toBe("draft");

    await db.update(outreachMessages).set({ status: "queued" }).where(eq(outreachMessages.id, draft.id));
    await runOutreach(db);
    expect(mail.sent).toHaveLength(1);
    // Автор мовчить: настав строк — нагадування з першої чернетки, теж на затвердження.
    await db.update(outreachThreads).set({ nextActionAt: new Date(Date.now() - 1000) });
    resetOutreachTimers();
    await runOutreach(db);
    const msgs = await db.select().from(outreachMessages).orderBy(outreachMessages.id);
    expect(msgs.map((m) => [m.kind, m.status])).toEqual([["first", "sent"], ["followup", "draft"]]);
    expect(msgs[1].body).toBe("Hi Anna, just checking in. {{sender_name}}");

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ message: { content: JSON.stringify({ summary: "stop", unsubscribe: { value: true, quote: "please remove me" } }) } }] })));
    mail.inbox.push({ uid: 5, messageId: "<r2@gmail.com>", inReplyTo: mail.sent[0].messageId, references: [], from: "anna@gmail.com", subject: "Re", date: new Date(), auto: false, bounce: false, text: "Not interested, please remove me from your list." });
    await db.update(mailboxes).set({ lastUid: 0, uidValidity: "1" });
    resetOutreachTimers();
    await runOutreach(db);
    const [t] = await db.select().from(outreachThreads);
    expect(t.status).toBe("declined");
    expect(await db.select().from(suppressions)).toEqual([expect.objectContaining({ key: emailKey("anna@gmail.com") })]);
    // Нагадування-чернетку відкликано.
    const [fu] = await db.select().from(outreachMessages).where(eq(outreachMessages.kind, "followup"));
    expect(fu.status).toBe("discarded");
    // Новий лист цьому автору вже не почнеться.
    const again = await startThread(db, { creatorId: c.id, clientId: client.id });
    expect(again.error).toBe("Автор у списку виключень");
  });

  it("after shipping, finds the post on the creator's profile and records it", async () => {
    const { db, client, c } = await setup();
    fakeMail();
    const { id } = await startThread(db, { creatorId: c.id, clientId: client.id });
    await db.update(outreachThreads).set({ status: "to_ship", agreedAt: new Date(Date.now() - 86_400_000), subject: "Glow Lab x Anna" }).where(eq(outreachThreads.id, id!));
    await markShipped(db, id!);
    await db.update(outreachThreads).set({ nextActionAt: new Date(Date.now() - 1000) });
    await addTestKey(db, "apify", "ap");
    const post = { shortCode: "P1", url: "https://www.instagram.com/p/P1/", caption: "Evening glow with @glowlab #ad", mentions: ["glowlab"], timestamp: new Date().toISOString(), ownerUsername: "anna", type: "Video" };
    const profile = { username: "anna", fullName: "Anna", followersCount: 5200, url: "https://www.instagram.com/anna/", latestPosts: [post] };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/users/me/limits")) return Response.json({ data: { limits: { maxMonthlyUsageUsd: 5 }, current: { monthlyUsageUsd: 0.02 } } });
      if (url.includes("/runs?")) return Response.json({ data: { id: "run1", status: "RUNNING", defaultDatasetId: "ds1" } }, { status: 201 });
      if (url.includes("/actor-runs/run1")) return Response.json({ data: { id: "run1", status: "SUCCEEDED", defaultDatasetId: "ds1", usageTotalUsd: 0.003 } });
      if (url.includes("/datasets/ds1/items")) return Response.json([profile]);
      throw new Error(`unexpected ${url}`);
    }));
    await runOutreach(db);
    const [t] = await db.select().from(outreachThreads);
    expect([t.status, t.postUrl, t.postCheck?.disclosure, t.needsHuman]).toEqual(["posted", "https://www.instagram.com/p/P1/", true, null]);
    const [cr] = await db.select().from(creators);
    expect(cr.outreachStatus).toBe("posted");
  });
});
