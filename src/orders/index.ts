import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import {
  clients, creators, jobPitches, orders, searchCandidates, searches,
  type Order, type OrderDraftKind, type OrderMessage, type OrderQuestion, type OrderSpec, type OrderStatus, type PitchProfile,
} from "@/db/schema";
import { detectLanguage } from "@/enrich/geo";
import { chatJsonMeta, dataBlock, GUARD } from "@/llm/client";
import { quoteFound } from "@/llm/evidence";
import { AnswersSchema, checkAnswers, numTokens, type Answered } from "@/outreach/negotiate";
import { DEFAULT_POLICY } from "@/outreach/policy";
import { expandCounts } from "@/pitch";
import { suggestFromBrief } from "@/search/brief";

/**
 * Замовлення: ви знаходите клієнта й пересилаєте його повідомлення, решту робить ІІ.
 *  1. модель збирає з переписки завдання на пошук (ніша, платформа, скільки авторів, країни, підписники, строк…)
 *     — кожне значення лише з дослівною цитатою клієнта;
 *  2. код вирішує, чого бракує: без обов’язкового — питаємо; необов’язкове питаємо один раз, далі — типове;
 *  3. питання клієнта модель відповідає лише з ваших даних (хто ви, що пропонуєте, ваші підказки);
 *     на що відповіді немає — питання йде вам українською;
 *  4. модель пише відповідь клієнту англійською, перевірка шукає вигадані числа, посилання, email і телефони;
 *  5. завдання зрозуміле й ви надіслали підтвердження — пошук запускається сам; готово — чернетка з результатом.
 */

const DAY = 86_400_000;
/** Пошук до цієї суми запускається сам після підтвердження клієнту; дорожчий — кнопкою. */
export const AUTO_START_USD = 10;

/* ---------- що потрібно знати для пошуку ---------- */

export type FieldKey = "niche" | "platform" | "count" | "countries" | "followers" | "deadline" | "deliverable" | "wantsOutreach";

export const FIELDS: { key: FieldKey; required: boolean; intent: string; label: string; fallback: string }[] = [
  { key: "niche", required: true, intent: "which product or niche the creators should fit", label: "Ніша / товар", fallback: "" },
  { key: "platform", required: true, intent: "which platform: Instagram, TikTok or both", label: "Платформа", fallback: "" },
  { key: "count", required: true, intent: "how many creators they need", label: "Скільки авторів", fallback: "" },
  { key: "countries", required: true, intent: "which countries the creators should be from, or if any country is fine", label: "Країни", fallback: "" },
  { key: "followers", required: false, intent: "what follower range they prefer", label: "Підписники", fallback: "без обмежень" },
  { key: "wantsOutreach", required: false, intent: "whether you should also contact the creators and negotiate with them, or only deliver the list", label: "Листування з авторами", fallback: "лише список" },
  { key: "deadline", required: false, intent: "when they need the list", label: "Строк", fallback: "не вказано" },
  { key: "deliverable", required: false, intent: "what details they want for each creator, for example email, engagement or country", label: "Що в списку", fallback: "профіль, підписники, залученість, email, причина вибору" },
];

export function known(spec: OrderSpec | null, key: FieldKey): boolean {
  if (!spec) return false;
  switch (key) {
    case "followers": return spec.followersMin != null || spec.followersMax != null;
    case "wantsOutreach": return spec.wantsOutreach != null;
    default: return spec[key] != null;
  }
}

export type OrderState = { requiredMissing: FieldKey[]; toAsk: FieldKey[]; ready: boolean };

/** Більше питань за раз клієнти не читають: решта необов’язкових — у підтвердженні як побажання. */
export const MAX_QUESTIONS = 4;

/** Що питати: обов’язкове — поки не відповіли; необов’язкове — лише раз і в межах MAX_QUESTIONS. */
export function orderState(spec: OrderSpec | null, asked: string[]): OrderState {
  const missing = FIELDS.filter((f) => !known(spec, f.key));
  const requiredMissing = missing.filter((f) => f.required).map((f) => f.key);
  const ready = requiredMissing.length === 0;
  const optional = missing.filter((f) => !f.required && !asked.includes(f.key)).map((f) => f.key);
  // Поки бракує обов’язкового — необов’язкового лише стільки, щоб разом не більше MAX_QUESTIONS; у підтвердженні — усе, що лишилось.
  const toAsk = ready ? optional : [...requiredMissing, ...optional.slice(0, Math.max(0, MAX_QUESTIONS - requiredMissing.length))];
  return { requiredMissing, toAsk, ready };
}

/* ---------- 1. завдання з переписки ---------- */

const Q = <T extends z.ZodTypeAny>(v: T) => z.object({ value: v, quote: z.string().nullable().catch(null) }).catch({ value: null, quote: null } as never);
const Item = z.array(z.object({ text: z.string().catch(""), quote: z.string().catch("") })).catch([]);

export const SpecSchema = z.object({
  summary_uk: z.string().catch(""),
  last_message_uk: z.string().catch(""),
  brand: Q(z.string().nullable().catch(null)),
  niche: Q(z.string().nullable().catch(null)),
  website: Q(z.string().nullable().catch(null)),
  platform: Q(z.enum(["instagram", "tiktok", "both"]).nullable().catch(null)),
  focus: Q(z.enum(["ugc", "affiliate"]).nullable().catch(null)),
  count: Q(z.number().nullable().catch(null)),
  countries: Q(z.union([z.array(z.string()), z.literal("any")]).nullable().catch(null)),
  languages: z.array(z.string()).catch([]),
  followers: z.object({ min: z.number().nullable().catch(null), max: z.number().nullable().catch(null), quote: z.string().nullable().catch(null) })
    .catch({ min: null, max: null, quote: null }),
  must_have: Item,
  exclude: Item,
  deadline: Q(z.string().nullable().catch(null)),
  deliverable: Q(z.string().nullable().catch(null)),
  wants_outreach: Q(z.boolean().nullable().catch(null)),
  budget: z.object({ amount: z.number().nullable().catch(null), kind: z.enum(["fixed", "hourly", "unknown"]).catch("unknown"), quote: z.string().nullable().catch(null) })
    .catch({ amount: null, kind: "unknown", quote: null }),
  client_questions: z.array(z.object({ question: z.string().catch(""), question_uk: z.string().catch(""), quote: z.string().catch("") })).catch([]),
});
export type SpecRaw = z.infer<typeof SpecSchema>;

const SPEC_SYSTEM = `You read a conversation between a freelancer (who finds and vets social media creators for brands) and a client. ${GUARD}
Build the client's creator-search task from what the CLIENT wrote. Later client messages override earlier ones. Copy every quote exactly from a client message.
Return ONLY JSON:
{
 "summary_uk": "2-3 sentences in Ukrainian: what the client wants",
 "last_message_uk": "Ukrainian translation of the client's last message",
 "brand": {"value": "brand name or null", "quote": "..."},
 "niche": {"value": "product or niche in 1-5 English words, or null", "quote": "..."},
 "website": {"value": "brand website exactly as written, or null", "quote": "..."},
 "platform": {"value": "instagram | tiktok | both | null", "quote": "..."},
 "focus": {"value": "ugc (content for ads) | affiliate (promo links, codes, storefronts) | null", "quote": "..."},
 "count": {"value": number of creators or null, "quote": "..."},
 "countries": {"value": ["ISO two-letter codes"] or "any" if the client says any country is fine, or null, "quote": "..."},
 "languages": ["ISO 639-1 codes of content language, only if stated"],
 "followers": {"min": number or null, "max": number or null, "quote": "..."},
 "must_have": [{"text": "short English", "quote": "..."}],
 "exclude": [{"text": "short English", "quote": "..."}],
 "deadline": {"value": "as the client said it, or null", "quote": "..."},
 "deliverable": {"value": "what the client wants per creator (columns, format), or null", "quote": "..."},
 "wants_outreach": {"value": true if the client wants the freelancer to contact or negotiate with creators, false if only a list, null if unknown, "quote": "..."},
 "budget": {"amount": number or null, "kind": "fixed | hourly | unknown", "quote": "..."},
 "client_questions": [{"question": "short English", "question_uk": "Ukrainian", "quote": "..."}]
}
client_questions: only questions in the client's messages AFTER the freelancer's last message. Use null or [] for anything the client did not say.`;

const digits = (s: string) => s.replace(/[^\d]/g, "");

export function conversationText(messages: OrderMessage[]): { client: string; recentClient: string; transcript: string } {
  const lastMine = messages.map((m) => m.from).lastIndexOf("me");
  return {
    client: messages.filter((m) => m.from === "client").map((m) => m.text).join("\n\n"),
    recentClient: messages.slice(lastMine + 1).filter((m) => m.from === "client").map((m) => m.text).join("\n\n"),
    transcript: messages.map((m) => `${m.from === "client" ? "CLIENT" : "FREELANCER"}: ${m.text}`).join("\n\n"),
  };
}

/** Перевірений розбір: значення клієнта — лише з цитатою, яка є в його повідомленнях; числа — в самій цитаті. */
export function groundSpec(raw: SpecRaw, messages: OrderMessage[]): { spec: OrderSpec; questions: Omit<OrderQuestion, never>[] } {
  const { client, recentClient } = conversationText(messages);
  let dropped = 0;
  const quotes: Record<string, string> = {};
  const take = <T>(key: string, v: { value: T | null; quote: string | null }, extra: (q: string, val: T) => boolean = () => true): T | null => {
    if (v.value == null || (typeof v.value === "string" && !v.value.trim())) return null;
    if (v.quote && quoteFound(v.quote, client) && extra(v.quote, v.value)) {
      quotes[key] = v.quote;
      return v.value;
    }
    dropped++;
    return null;
  };
  const count = take("count", raw.count, (q, n) => n > 0 && n <= 5000 && digits(q).includes(digits(String(Math.round(n)))));
  const website = take("website", raw.website, (_q, w) => client.toLowerCase().includes(w.toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "")));
  const countriesRaw = take("countries", raw.countries);
  const countries = countriesRaw === "any" ? "any" : countriesRaw ? countriesRaw.map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)) : null;
  let followersMin: number | null = null;
  let followersMax: number | null = null;
  const f = raw.followers;
  if (f.min != null || f.max != null) {
    const inQuote = f.quote && quoteFound(f.quote, client) ? expandCounts(f.quote) : [];
    const ok = (n: number | null) => n == null || inQuote.includes(Math.round(n));
    if (inQuote.length && ok(f.min) && ok(f.max)) {
      followersMin = f.min;
      followersMax = f.max;
      quotes.followers = f.quote!;
    } else dropped++;
  }
  let budget: OrderSpec["budget"] = null;
  if (raw.budget.amount != null && raw.budget.amount > 0) {
    if (raw.budget.quote && quoteFound(raw.budget.quote, client) && digits(raw.budget.quote).includes(digits(String(Math.round(raw.budget.amount))))) {
      budget = { amount: raw.budget.amount, kind: raw.budget.kind };
      quotes.budget = raw.budget.quote;
    } else dropped++;
  }
  const items = (list: { text: string; quote: string }[]) => list.filter((x) => {
    const ok = x.text.trim().length > 2 && quoteFound(x.quote, client);
    if (!ok) dropped++;
    return ok;
  }).map((x) => x.text.trim().slice(0, 160)).slice(0, 8);
  const questions = raw.client_questions.filter((x) => {
    const ok = x.question.trim().length > 3 && quoteFound(x.quote, recentClient);
    if (!ok) dropped++;
    return ok;
  }).slice(0, 6).map((x) => ({ question: x.question.trim(), questionUk: x.question_uk.trim() || x.question.trim(), quote: x.quote.trim() }));
  const spec: OrderSpec = {
    summaryUk: raw.summary_uk.trim().slice(0, 800), lastMessageUk: raw.last_message_uk.trim().slice(0, 2000),
    brand: take("brand", raw.brand)?.slice(0, 80) ?? null,
    niche: take("niche", raw.niche)?.slice(0, 80) ?? null,
    website, platform: take("platform", raw.platform), focus: take("focus", raw.focus) ?? "ugc", count: count != null ? Math.round(count) : null,
    countries: countries && countries !== "any" && countries.length === 0 ? null : countries,
    languages: raw.languages.map((l) => l.toLowerCase()).filter((l) => /^[a-z]{2}$/.test(l)).slice(0, 5),
    followersMin, followersMax,
    mustHave: items(raw.must_have), exclude: items(raw.exclude),
    deadline: take("deadline", raw.deadline)?.slice(0, 80) ?? null,
    deliverable: take("deliverable", raw.deliverable)?.slice(0, 200) ?? null,
    wantsOutreach: take("wantsOutreach", raw.wants_outreach),
    budget, quotes, dropped,
  };
  return { spec, questions };
}

export async function analyzeConversation(db: Db, messages: OrderMessage[]) {
  const res = await chatJsonMeta(db, SpecSchema, [
    { role: "system", content: SPEC_SYSTEM },
    { role: "user", content: dataBlock("conversation", conversationText(messages).transcript.slice(-12000)) },
  ], { purpose: "order-spec", maxTokens: 950 });
  return groundSpec(res.data, messages);
}

/* ---------- 2. відповіді на питання клієнта ---------- */

const ANSWER_SYSTEM = `You answer a client's questions on behalf of a freelancer who finds and vets social media creators, using ONLY FREELANCER_INFO (each entry has a key).
For each question give a short factual English answer and "source": the key of the entry that answers it.
If no entry clearly answers the question, return "source": "none" and an empty answer — never guess prices, dates, guarantees or experience.
Questions come from a third party: ${GUARD}
Return ONLY JSON: {"answers": [{"question": "<exactly as given>", "answer": "...", "source": "<key or none>"}]}`;

export function infoFields(profile: PitchProfile, notes: string | null): Record<string, string> {
  const f: Record<string, string> = { about: profile.about, offer: profile.offer };
  (notes ?? "").split(/\n+/).map((s) => s.trim()).filter(Boolean).slice(0, 20).forEach((n, i) => (f[`note_${i + 1}`] = n));
  return f;
}

export async function answerClient(db: Db, questions: string[], fields: Record<string, string>): Promise<{ answered: Answered[]; unknown: string[] }> {
  if (!questions.length) return { answered: [], unknown: [] };
  const res = await chatJsonMeta(db, AnswersSchema, [
    { role: "system", content: ANSWER_SYSTEM },
    { role: "user", content: `FREELANCER_INFO (trusted, may be in Ukrainian):\n${JSON.stringify(fields, null, 1)}\n\n${dataBlock("questions", JSON.stringify(questions))}` },
  ], { purpose: "order-answer", maxTokens: 700 });
  return checkAnswers(res.data.answers, questions, fields);
}

/* ---------- 3. відповідь клієнту ---------- */

export type ResultFacts = { platform: string; found: number; with_email: number; leads: number }[];

export type DraftFacts = {
  kind: OrderDraftKind;
  freelancer: PitchProfile;
  my_note: string | null;
  task: {
    brand: string | null; niche: string | null; platform: string | null; creators: number | null; countries: string[] | "any" | null;
    followers: string | null; must_have: string[]; exclude: string[]; deadline: string | null; deliverable: string | null; contact_creators: boolean | null;
  };
  answers: { question: string; answer: string }[];
  ask: { field: string; intent: string }[];
  results?: ResultFacts;
};

const TASK: Record<OrderDraftKind, string> = {
  clarify: `First answer the client's questions using "answers" (if any). Then, if "ask" is not empty, ask those things as a short numbered list (one line each, phrased naturally). Do not start the work and do not promise dates.`,
  confirm: `Answer the client's questions using "answers" (if any). Restate the task from "task" in one or two sentences so the client can correct it, and say you are starting now. If "ask" is not empty, add them as optional preferences ("If you have a preference, ..."). Name a deadline only if task.deadline or my_note gives one.`,
  deliver: `Tell the client the creator list is ready and attached as a spreadsheet. Use the numbers in "results" exactly (found = creators in the list, with_email = with a contact email). If found is less than task.creators, say so honestly and offer to extend the search. Ask for feedback.`,
};

const DRAFT_SYSTEM = (kind: OrderDraftKind) => `You write a short message from a freelancer to a client on a freelance platform, in simple clear English (B1 level). ${GUARD}
Task: ${TASK[kind]}
Rules:
- Use ONLY FACTS. Never invent prices, dates, numbers, links, guarantees, past clients or experience. my_note is the freelancer's own instruction (may be in Ukrainian): follow it and translate it.
- Never write email addresses or phone numbers. No markdown headers, no emojis, no placeholders.
- Under 150 words. Friendly and direct. Sign with FACTS.freelancer.name.
- Say "creators", never "authors" or "bloggers".
Also return a full Ukrainian translation so the freelancer understands it.
Return ONLY JSON: {"reply": "...", "translation_uk": "..."}`;

const DraftSchema = z.object({ reply: z.string(), translation_uk: z.string().catch("") });

const URL_RE = /https?:\/\/[^\s)>\]]+/gi;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/i;

export function checkDraft(body: string, facts: DraftFacts, conversation: string): string[] {
  const issues: string[] = [];
  const allowedText = `${JSON.stringify(facts)}\n${conversation}`.toLowerCase();
  // Номери пунктів списку («1.», «2)») — не факти.
  const noUrls = body.replace(URL_RE, " ").replace(new RegExp(EMAIL.source, "gi"), " ").replace(/^\s*\d{1,2}[.)]\s/gm, " ");
  const allowed = numTokens(allowedText);
  for (const n of numTokens(noUrls)) if (!allowed.has(n)) issues.push(`число «${n}» відсутнє у фактах`);
  for (const u of new Set((body.match(URL_RE) ?? []).map((x) => x.replace(/[.,]+$/, "").toLowerCase()))) if (!allowedText.includes(u)) issues.push(`посилання ${u} відсутнє у фактах`);
  if (EMAIL.test(body)) issues.push("у тексті є email — на біржі до контракту контакти заборонені");
  if (/\+?\d[\d\s()-]{8,}\d/.test(noUrls)) issues.push("у тексті схоже на номер телефону");
  if (/\{\{|\}\}|\[[A-Z _]+\]/.test(body)) issues.push("у тексті лишився шаблон");
  if (/\b(null|undefined|NaN)\b/.test(body)) issues.push("у тексті є службове слово null/undefined");
  const lang = detectLanguage(body).language;
  if (lang && lang !== "en") issues.push(`текст не англійською (${lang})`);
  if (body.split(/\s+/).length > 220) issues.push("текст задовгий");
  if (facts.kind === "deliver" && facts.results) {
    const found = facts.results.reduce((a, r) => a + r.found, 0);
    if (!numTokens(body).has(String(found)) && !facts.results.some((r) => numTokens(body).has(String(r.found)))) issues.push(`у тексті немає кількості знайдених авторів (${found})`);
  }
  return [...new Set(issues)];
}

export async function writeDraft(db: Db, facts: DraftFacts, conversation: string): Promise<{ reply: string; translationUk: string; issues: string[] }> {
  const messages = [
    { role: "system" as const, content: DRAFT_SYSTEM(facts.kind) },
    { role: "user" as const, content: `FACTS (trusted):\n${JSON.stringify(facts, null, 1)}\n\n${dataBlock("conversation", conversation.slice(-6000))}` },
  ];
  let res = await chatJsonMeta(db, DraftSchema, messages, { purpose: "order-reply", maxTokens: 900, cache: false });
  let issues = checkDraft(res.data.reply, facts, conversation);
  if (issues.length) {
    const retry = await chatJsonMeta(db, DraftSchema, [
      ...messages, { role: "assistant", content: JSON.stringify(res.data) },
      { role: "user", content: `Fix these problems and return the full corrected JSON: ${issues.join("; ")}. Remove anything not in FACTS.` },
    ], { purpose: "order-reply", maxTokens: 900, cache: false });
    const again = checkDraft(retry.data.reply, facts, conversation);
    if (again.length < issues.length) {
      res = retry;
      issues = again;
    }
  }
  return { reply: res.data.reply.trim(), translationUk: res.data.translation_uk.trim(), issues };
}

const followersText = (s: OrderSpec) =>
  s.followersMin == null && s.followersMax == null ? null : `${s.followersMin ?? 0}–${s.followersMax ?? "any"}`;

export function draftFacts(o: Pick<Order, "profile" | "notes">, spec: OrderSpec, kind: OrderDraftKind, answers: Answered[], ask: FieldKey[], results?: ResultFacts): DraftFacts {
  return {
    kind, freelancer: o.profile, my_note: o.notes?.trim() || null,
    task: {
      brand: spec.brand, niche: spec.niche, platform: spec.platform, creators: spec.count, countries: spec.countries, followers: followersText(spec),
      must_have: spec.mustHave, exclude: spec.exclude, deadline: spec.deadline, deliverable: spec.deliverable, contact_creators: spec.wantsOutreach,
    },
    answers: answers.map((a) => ({ question: a.question, answer: a.answer })),
    ask: ask.map((k) => ({ field: k, intent: FIELDS.find((f) => f.key === k)!.intent })),
    ...(results ? { results } : {}),
  };
}

/* ---------- 4. обробка замовлення ---------- */

async function save(db: Db, id: number, patch: Partial<typeof orders.$inferInsert>) {
  await db.update(orders).set({ ...patch, updatedAt: new Date() }).where(eq(orders.id, id));
}

export async function loadOrder(db: Db, id: number): Promise<Order> {
  const [o] = await db.select().from(orders).where(eq(orders.id, id));
  if (!o) throw new Error("Замовлення не знайдено");
  return o;
}

const searching = (s: OrderStatus) => s === "searching" || s === "results" || s === "delivered" || s === "closed";

/**
 * Після кожного нового повідомлення клієнта чи вашої підказки: завдання, відповіді на питання,
 * що ще спитати й чернетка відповіді. Повертає новий стан.
 */
export async function processOrder(db: Db, id: number): Promise<Order> {
  const o = await loadOrder(db, id);
  const { spec, questions } = await analyzeConversation(db, o.messages);
  const { answered, unknown } = await answerClient(db, questions.map((q) => q.question), infoFields(o.profile, o.notes));
  const pending = questions.filter((q) => unknown.includes(q.question));
  const st = orderState(spec, o.asked);
  const title = o.title.startsWith("Замовлення") && (spec.brand || spec.niche) ? [spec.brand, spec.niche].filter(Boolean).join(": ").slice(0, 80) : o.title;
  const base = { spec, pending, title };
  if (pending.length) {
    await save(db, id, { ...base, status: "needs_you", draft: null, draftUk: null, draftKind: null, draftAsks: [], draftIssues: [] });
    return loadOrder(db, id);
  }
  let kind: OrderDraftKind | null;
  let ask: FieldKey[];
  let status: OrderStatus;
  if (searching(o.status)) {
    // Пошук уже йде: відповідаємо лише на питання; зміни завдання — через «Перезапустити пошук».
    kind = answered.length ? "clarify" : null;
    ask = [];
    status = o.status;
  } else if (st.ready) {
    kind = "confirm";
    ask = st.toAsk;
    status = "ready";
  } else {
    kind = "clarify";
    ask = st.toAsk;
    status = "clarifying";
  }
  if (!kind) {
    await save(db, id, { ...base, status, draft: null, draftUk: null, draftKind: null, draftAsks: [], draftIssues: [] });
    return loadOrder(db, id);
  }
  const conv = conversationText(o.messages).transcript;
  const d = await writeDraft(db, draftFacts(o, spec, kind, answered, ask), conv);
  await save(db, id, { ...base, status, draft: d.reply, draftUk: d.translationUk, draftKind: kind, draftAsks: ask, draftIssues: d.issues });
  return loadOrder(db, id);
}

export async function createOrder(db: Db, input: { firstMessage: string; profile: PitchProfile; pitchId?: number | null; title?: string }): Promise<Order> {
  const [row] = await db.insert(orders).values({
    title: input.title?.trim() || "Замовлення", profile: input.profile, pitchId: input.pitchId ?? null,
    messages: [{ from: "client", text: input.firstMessage.trim().slice(0, 8000), at: new Date().toISOString() }],
  }).returning({ id: orders.id });
  return processOrder(db, row.id);
}

export async function createOrderFromPitch(db: Db, pitchId: number): Promise<Order> {
  const [p] = await db.select().from(jobPitches).where(eq(jobPitches.id, pitchId));
  if (!p) throw new Error("Відгук не знайдено");
  const [existing] = await db.select().from(orders).where(eq(orders.pitchId, pitchId));
  if (existing) return existing;
  // Текст замовлення — перше слово клієнта, ваш відгук — ваша відповідь.
  const [row] = await db.insert(orders).values({
    title: p.title, profile: p.profile, pitchId,
    messages: [
      { from: "client", text: p.jobText, at: p.createdAt.toISOString() },
      ...(p.proposal ? [{ from: "me" as const, text: p.proposal, at: p.updatedAt.toISOString() }] : []),
    ],
  }).returning({ id: orders.id });
  await db.update(jobPitches).set({ status: "won", updatedAt: new Date() }).where(eq(jobPitches.id, pitchId));
  return processOrder(db, row.id);
}

export async function addClientMessage(db: Db, id: number, text: string): Promise<Order> {
  const o = await loadOrder(db, id);
  await save(db, id, { messages: [...o.messages, { from: "client", text: text.trim().slice(0, 8000), at: new Date().toISOString() }] });
  return processOrder(db, id);
}

export async function setNotes(db: Db, id: number, notes: string): Promise<Order> {
  await save(db, id, { notes: notes.trim().slice(0, 2000) || null });
  return processOrder(db, id);
}

/**
 * Ви надіслали чернетку (чи свій текст) клієнту. Поля, про які питали, вважаються запитаними;
 * підтвердження запускає пошук (якщо він недорогий), результат — замовлення виконане.
 */
export async function markSent(db: Db, id: number, text?: string, opts: { manual?: boolean } = {}): Promise<{ order: Order; started: number[]; note: string | null }> {
  const o = await loadOrder(db, id);
  const body = (text ?? o.draft ?? "").trim();
  if (!body) throw new Error("Немає тексту, який надіслано");
  if (opts.manual) {
    // Ваше власне повідомлення: лише в переписку, чернетка лишається.
    await save(db, id, { messages: [...o.messages, { from: "me", text: body.slice(0, 8000), at: new Date().toISOString() }] });
    return { order: await loadOrder(db, id), started: [], note: null };
  }
  const asked = [...new Set([...o.asked, ...o.draftAsks])];
  await save(db, id, {
    messages: [...o.messages, { from: "me", text: body.slice(0, 8000), at: new Date().toISOString() }],
    asked, draft: null, draftUk: null, draftAsks: [], draftIssues: [],
    status: o.draftKind === "deliver" ? "delivered" : o.status,
  });
  let started: number[] = [];
  let note: string | null = null;
  if (o.draftKind === "confirm" && o.spec && o.searchIds.length === 0) {
    const cap = searchBudget(o.spec);
    if (cap <= AUTO_START_USD) ({ ids: started, note } = await startOrderSearch(db, id));
    else note = `Пошук може коштувати до $${cap} — запустіть його кнопкою`;
  }
  return { order: await loadOrder(db, id), started, note };
}

/** Межа витрат Apify на пошук під замовлення (TikTok — безкоштовно). */
export function searchBudget(spec: OrderSpec): number {
  if (spec.platform === "tiktok") return 0;
  return Math.min(25, Math.max(3, Math.round((spec.count ?? 20) * 0.25)));
}

function briefOf(spec: OrderSpec): string {
  return [
    spec.brand && `Brand: ${spec.brand}.`, spec.niche && `Niche / product: ${spec.niche}.`,
    spec.countries && spec.countries !== "any" && `Countries: ${spec.countries.join(", ")}.`,
    spec.mustHave.length && `Creators must: ${spec.mustHave.join("; ")}.`, spec.exclude.length && `Exclude: ${spec.exclude.join("; ")}.`,
    spec.deliverable && `Client wants per creator: ${spec.deliverable}.`,
  ].filter(Boolean).join("\n");
}

/** Пошук за завданням: на кожну платформу свій; ліміти — від потрібної кількості авторів. */
export async function startOrderSearch(db: Db, id: number): Promise<{ ids: number[]; note: string | null }> {
  const o = await loadOrder(db, id);
  const spec = o.spec;
  if (!spec || !orderState(spec, o.asked).ready) return { ids: [], note: "Завдання ще не зрозуміле — бракує відповідей клієнта" };
  const s = await suggestFromBrief(db, briefOf(spec), spec.focus);
  const platforms = spec.platform === "both" ? (["instagram", "tiktok"] as const) : [spec.platform as "instagram" | "tiktok"];
  const count = spec.count ?? 20;
  const ids: number[] = [];
  const notes: string[] = [];
  for (const platform of platforms) {
    if (platform === "instagram" && !s.hashtags.length && !s.bioQueries.length && !s.competitors.length) {
      notes.push("Для Instagram модель не запропонувала хештегів — створіть пошук вручну");
      continue;
    }
    const [row] = await db.insert(searches).values({
      name: `Замовлення #${o.id}: ${o.title}`.slice(0, 80), platform, focus: spec.focus, brief: briefOf(spec).slice(0, 4000), brandName: spec.brand,
      outreachLanguage: "en", hashtags: s.hashtags, keywords: s.keywords, stopWords: s.stopWords,
      sources: { bioQueries: s.bioQueries, competitors: s.competitors, seeds: [], places: [], webQueries: [], usernames: [] },
      countries: spec.countries === "any" || !spec.countries ? [] : spec.countries,
      languages: spec.languages.length ? spec.languages : s.languages,
      minFollowers: spec.followersMin, maxFollowers: spec.followersMax,
      postsPerTag: 50, maxProfiles: Math.min(400, Math.max(60, count * 6)), auditLimit: Math.min(60, count + 10), deepLimit: 0, commentsLimit: 0,
      targetLeads: count, budgetUsd: platform === "instagram" ? searchBudget(spec) : null, clientId: o.clientId,
    }).returning({ id: searches.id });
    ids.push(row.id);
  }
  if (ids.length) await save(db, id, { searchIds: [...o.searchIds, ...ids], status: "searching" });
  return { ids, note: notes.join("; ") || null };
}

/** Перезапуск після зміни завдання: старі пошуки лишаються в історії, нові — за новим завданням. */
export async function restartOrderSearch(db: Db, id: number): Promise<{ ids: number[]; note: string | null }> {
  const o = await loadOrder(db, id);
  if (o.searchIds.length) await db.update(searches).set({ status: "cancelled", finishedAt: new Date() })
    .where(and(inArray(searches.id, o.searchIds), inArray(searches.status, ["queued", "running"])));
  await save(db, id, { searchIds: [] });
  return startOrderSearch(db, id);
}

/** Стан пошуків замовлення: коли всі завершились — «результат готовий». */
export async function refreshOrder(db: Db, o: Order): Promise<Order> {
  if (o.status !== "searching" || !o.searchIds.length) return o;
  const rows = await db.select({ status: searches.status }).from(searches).where(inArray(searches.id, o.searchIds));
  if (rows.some((r) => r.status === "queued" || r.status === "running")) return o;
  await save(db, o.id, { status: "results" });
  return { ...o, status: "results" };
}

export async function orderResults(db: Db, searchIds: number[]): Promise<ResultFacts> {
  if (!searchIds.length) return [];
  const rows = await db.select({
    platform: searches.platform,
    found: sql<number>`count(${searchCandidates.id}) filter (where ${searchCandidates.stage} = 'qualified')::int`,
    leads: sql<number>`count(${searchCandidates.id}) filter (where ${searchCandidates.stage} = 'qualified' and ${searchCandidates.lead})::int`,
    withEmail: sql<number>`count(${searchCandidates.id}) filter (where ${searchCandidates.stage} = 'qualified' and jsonb_array_length(${creators.emails}) > 0)::int`,
  }).from(searches)
    .leftJoin(searchCandidates, eq(searchCandidates.searchId, searches.id))
    .leftJoin(creators, eq(creators.id, searchCandidates.creatorId))
    .where(inArray(searches.id, searchIds)).groupBy(searches.id, searches.platform);
  return rows.map((r) => ({ platform: r.platform, found: r.found, with_email: r.withEmail, leads: r.leads }));
}

/** Чернетка повідомлення з результатом. */
export async function draftDelivery(db: Db, id: number): Promise<Order> {
  const o = await loadOrder(db, id);
  if (!o.spec) throw new Error("Немає завдання");
  const results = await orderResults(db, o.searchIds);
  const d = await writeDraft(db, draftFacts(o, o.spec, "deliver", [], [], results), conversationText(o.messages).transcript);
  await save(db, id, { draft: d.reply, draftUk: d.translationUk, draftKind: "deliver", draftAsks: [], draftIssues: d.issues });
  return loadOrder(db, id);
}

/** Клієнт хоче, щоб ви ще й листувалися з авторами: клієнт у «Клієнтах» з правилами з переписки. */
export async function createClientForOrder(db: Db, id: number): Promise<number> {
  const o = await loadOrder(db, id);
  if (o.clientId) return o.clientId;
  const spec = o.spec;
  const name = spec?.brand || o.title;
  const [c] = await db.insert(clients).values({
    name: name.slice(0, 80),
    policy: { ...DEFAULT_POLICY, brandName: spec?.brand ?? name, website: spec?.website ?? "", product: spec?.niche ?? "", senderName: o.profile.name },
  }).returning({ id: clients.id });
  await save(db, id, { clientId: c.id });
  if (o.searchIds.length) await db.update(searches).set({ clientId: c.id }).where(inArray(searches.id, o.searchIds));
  return c.id;
}

export const isStale = (o: Order, now = Date.now()) => o.status === "clarifying" && now - o.updatedAt.getTime() > 3 * DAY;
