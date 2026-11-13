import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { creators, orders, searchCandidates, searches, type OrderMessage } from "@/db/schema";
import {
  addClientMessage, checkDraft, createOrder, draftDelivery, draftFacts, groundSpec, markSent, orderState, refreshOrder, setNotes, SpecSchema,
} from "@/orders";
import { addTestKey, testDb } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const at = new Date().toISOString();
const FIRST = "Hi! We sell natural dog treats and need 25 creators with dogs who can film UGC videos for our ads. Can you include their emails?";
const msgs: OrderMessage[] = [
  { from: "client", text: FIRST, at },
  { from: "me", text: "Thanks! Which platform and countries?", at },
  { from: "client", text: "TikTok, UK only. 10k-100k followers. Do you offer refunds?", at },
];
const profile = { name: "Yevhen", about: "I find and vet creators with my own tool and find a contact email for each creator when it is public.", offer: "A vetted list in 48 hours." };

describe("search task from the client's words", () => {
  it("keeps values only with a client quote; numbers must be in the quote", () => {
    const { spec, questions } = groundSpec(SpecSchema.parse({
      niche: { value: "dog treats", quote: "natural dog treats" }, platform: { value: "tiktok", quote: "TikTok, UK only" },
      count: { value: 25, quote: "need 25 creators" }, countries: { value: ["GB"], quote: "UK only" },
      followers: { min: 10000, max: 100000, quote: "10k-100k followers" },
      deadline: { value: "Friday", quote: "by Friday" }, // клієнт цього не писав
      wants_outreach: { value: false, quote: "Thanks! Which platform" }, // це слова фрилансера, не клієнта
      client_questions: [
        { question: "Do you offer refunds?", question_uk: "Чи повертаєте гроші?", quote: "Do you offer refunds?" },
        { question: "Can you include emails?", quote: "Can you include their emails?" }, // уже відповіли раніше
      ],
    }), msgs);
    expect(spec).toMatchObject({ niche: "dog treats", platform: "tiktok", count: 25, countries: ["GB"], followersMin: 10000, followersMax: 100000, deadline: null, wantsOutreach: null });
    expect(spec.dropped).toBe(3);
    expect(questions.map((q) => q.question)).toEqual(["Do you offer refunds?"]);
    expect(groundSpec(SpecSchema.parse({ count: { value: 40, quote: "need 25 creators" } }), msgs).spec.count).toBeNull();
    expect(groundSpec(SpecSchema.parse({ countries: { value: "any", quote: "UK only" } }), msgs).spec.countries).toBe("any");
  });

  it("code decides what to ask: required until answered, optional once", () => {
    const { spec } = groundSpec(SpecSchema.parse({ niche: { value: "dog treats", quote: "natural dog treats" }, count: { value: 25, quote: "need 25 creators" } }), msgs.slice(0, 1));
    // Не більше 4 питань за раз: два обов’язкові + два найважливіші необов’язкові.
    expect(orderState(spec, [])).toEqual({ requiredMissing: ["platform", "countries"], toAsk: ["platform", "countries", "followers", "wantsOutreach"], ready: false });
    expect(orderState(spec, ["platform", "countries", "followers", "wantsOutreach"]).toAsk).toEqual(["platform", "countries", "deadline", "deliverable"]);
    expect(orderState(spec, ["platform", "countries", "followers", "deliverable", "deadline", "wantsOutreach"]).toAsk).toEqual(["platform", "countries"]);
    // Завдання зрозуміле — решта необов’язкових іде в підтвердження як побажання.
    const full = { ...spec, platform: "tiktok" as const, countries: "any" as const };
    expect(orderState(full, ["followers", "wantsOutreach"])).toEqual({ requiredMissing: [], toAsk: ["deadline", "deliverable"], ready: true });
  });

  it("checks the reply for invented numbers, contacts and the result count", () => {
    const { spec } = groundSpec(SpecSchema.parse({ count: { value: 25, quote: "need 25 creators" } }), msgs);
    const facts = draftFacts({ profile, notes: "строк 3 дні" }, spec, "deliver", [], [], [{ platform: "tiktok", found: 19, with_email: 12, leads: 10 }]);
    const conv = msgs.map((m) => m.text).join("\n");
    expect(checkDraft("The list is ready: 19 creators, 12 with email. I can extend the search to reach 25. Yevhen", facts, conv)).toEqual([]);
    const bad = checkDraft("Done! 30 creators, write me at me@mail.com or +44 7700 900123. Yevhen", facts, conv).join(" | ");
    expect(bad).toMatch(/«30»/);
    expect(bad).toMatch(/email/);
    expect(bad).toMatch(/телефону/);
    expect(bad).toMatch(/кількості знайдених/);
  });
});

/** Модель-заглушка: кожна відповідь клієнта — свій розбір. */
function fakeLlm(calls: string[]) {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const system: string = body.messages[0].content;
    const user: string = body.messages[1].content;
    let out: unknown;
    if (system.startsWith("You read a conversation")) {
      calls.push("spec");
      const second = user.includes("TikTok, UK only");
      out = {
        summary_uk: "Потрібні автори з собаками", last_message_uk: "…",
        niche: { value: "dog treats", quote: "natural dog treats" }, count: { value: 25, quote: "need 25 creators" },
        ...(second ? { platform: { value: "tiktok", quote: "TikTok, UK only" }, countries: { value: ["GB"], quote: "UK only" }, followers: { min: 10000, max: 100000, quote: "10k-100k followers" } } : {}),
        client_questions: second
          ? [{ question: "Do you offer refunds?", question_uk: "Чи повертаєте гроші?", quote: "Do you offer refunds?" }]
          : [{ question: "Can you include their emails?", question_uk: "Чи додасте email?", quote: "Can you include their emails?" }],
      };
    } else if (system.startsWith("You answer a client")) {
      calls.push("answer");
      const info = JSON.parse(user.slice(user.indexOf("{"), user.indexOf("\n\n<data")));
      const qs: string[] = JSON.parse(user.slice(user.indexOf("[", user.indexOf("<data")), user.lastIndexOf("]") + 1));
      out = {
        answers: qs.map((q) => /emails/.test(q) ? { question: q, answer: "Yes, a contact email when it is public", source: "about" }
          : info.note_1 ? { question: q, answer: "No refunds, but I redo the list for free", source: "note_1" } : { question: q, answer: "", source: "none" }),
      };
    } else if (system.startsWith("You help a creator-sourcing")) {
      calls.push("brief");
      out = { hashtags: ["dogsoftiktok"], keywords: ["dog"], bio_queries: ["dog mom"], countries: ["GB"], languages: ["en"] };
    } else {
      const kind = /Task: Tell the client the creator list is ready/.test(system) ? "deliver" : /Restate the task/.test(system) ? "confirm" : "clarify";
      calls.push(kind);
      const facts = JSON.parse(user.slice(user.indexOf("{"), user.indexOf("\n\n<data")));
      const reply = kind === "deliver"
        ? `The list is ready: ${facts.results[0].found} creators, ${facts.results[0].with_email} with email. Yevhen`
        : `${facts.answers.map((a: any) => a.answer).join(". ")}${facts.ask.length ? `\nQuestions:\n${facts.ask.map((a: any, i: number) => `${i + 1}. About ${a.field}?`).join("\n")}` : ""}\nYevhen`;
      out = { reply, translation_uk: "…" };
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify(out) } }] });
  }));
}

describe("order end to end", () => {
  it("asks what is missing, hands unknown questions to you, starts the search on confirmation and drafts the result", async () => {
    const db = await testDb();
    await addTestKey(db, "groq", "gq");
    const calls: string[] = [];
    fakeLlm(calls);

    // 1. Перше повідомлення: бракує платформи й країн — ІІ питає, а на питання про email відповідає з ваших даних.
    let o = await createOrder(db, { firstMessage: FIRST, profile });
    expect(o.status).toBe("clarifying");
    expect(o.draftKind).toBe("clarify");
    expect(o.draftAsks).toEqual(["platform", "countries", "followers", "wantsOutreach"]);
    expect(o.draft).toMatch(/contact email/);
    await markSent(db, o.id);

    // 2. Клієнт відповів і питає про повернення грошей — цього ІІ не знає: питання йде вам.
    o = await addClientMessage(db, o.id, "TikTok, UK only. 10k-100k followers. Do you offer refunds?");
    expect(o.status).toBe("needs_you");
    expect(o.pending.map((q) => q.questionUk)).toEqual(["Чи повертаєте гроші?"]);
    expect(o.draft).toBeNull();

    // 3. Ваша підказка — і завдання зрозуміле: підтвердження без повторних необов’язкових питань.
    o = await setNotes(db, o.id, "повернень немає, але переробляю список безкоштовно");
    expect(o.status).toBe("ready");
    expect(o.draftKind).toBe("confirm");
    // Що не спитали першим разом — як побажання в підтвердженні; пошук від цього не чекає.
    expect(o.draftAsks).toEqual(["deadline", "deliverable"]);
    expect(o.spec).toMatchObject({ platform: "tiktok", countries: ["GB"], count: 25, followersMin: 10000 });

    // 4. «Надіслав» — пошук TikTok (безкоштовний) запускається сам.
    const sent = await markSent(db, o.id);
    expect(sent.started).toHaveLength(1);
    const [s] = await db.select().from(searches).where(eq(searches.id, sent.started[0]));
    expect(s).toMatchObject({ platform: "tiktok", status: "queued", targetLeads: 25, minFollowers: 10000, maxFollowers: 100000, countries: ["GB"], hashtags: ["dogsoftiktok"] });
    expect(sent.order.status).toBe("searching");

    // 5. Пошук готовий — чернетка з результатом із реальних чисел.
    const made = await db.insert(creators).values([1, 2, 3].map((i) => ({ platform: "tiktok", username: `dog${i}`, emails: i < 3 ? [`d${i}@mail.com`] : [] }))).returning({ id: creators.id });
    await db.insert(searchCandidates).values(made.map((c) => ({ searchId: s.id, creatorId: c.id, stage: "qualified" as const, score: 70, lead: true })));
    await db.update(searches).set({ status: "done" }).where(eq(searches.id, s.id));
    const [row] = await db.select().from(orders).where(eq(orders.id, o.id));
    expect((await refreshOrder(db, row)).status).toBe("results");
    o = await draftDelivery(db, o.id);
    expect(o.draft).toBe("The list is ready: 3 creators, 2 with email. Yevhen");
    expect(o.draftIssues).toEqual([]);
    expect((await markSent(db, o.id)).order.status).toBe("delivered");
    // Розбір тієї самої переписки після підказки береться з кешу — модель не викликається вдруге.
    expect(calls).toEqual(["spec", "answer", "clarify", "spec", "answer", "answer", "confirm", "brief", "deliver"]);
  });
});
