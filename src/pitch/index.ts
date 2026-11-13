import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import {
  creators, jobPitches, searchCandidates, searches,
  type JobAnalysis, type JobPitch, type PitchOptions, type PitchProfile, type PitchSample,
} from "@/db/schema";
import { detectLanguage } from "@/enrich/geo";
import { profileUrl } from "@/lib/profile-url";
import { chatJsonMeta, dataBlock, GUARD, LlmUnavailableError } from "@/llm/client";
import { quoteFound } from "@/llm/evidence";
import { humanize, HUMAN_RULES, looksLikePhone, styleBlock, tellIssues } from "@/llm/human";
import { numTokens } from "@/outreach/negotiate";
import { suggestFromBrief } from "@/search/brief";

/**
 * Відгук на замовлення (Upwork тощо) у три кроки:
 *  1. модель розбирає текст замовлення: що треба, бюджет, вимоги, тривожні ознаки — кожен факт з дослівною цитатою,
 *     а код вирішує, чи варто братися (і пояснює українською);
 *  2. з того самого тексту — параметри пошуку й невеликий пошук авторів-прикладів під нішу замовника;
 *  3. модель пише короткий відгук англійською з ваших даних і знайдених авторів; перевірка шукає числа,
 *     @імена, посилання й email, яких немає у фактах, — досвіду чи результатів, яких у вас немає, у відгуку не буде.
 * Надсилаєте ви самі: Upwork забороняє автоматичну відправку відгуків.
 */

export const PITCH_VERSION = "pitch-v1";
export const SAMPLE_COUNT = 5;

/* ---------- 1. розбір замовлення ---------- */

const Quoted = <T extends z.ZodTypeAny>(v: T) => z.object({ value: v, quote: z.string().nullable().catch(null) });

export const JobSchema = z.object({
  title: z.string().catch(""),
  summary_uk: z.string().catch(""),
  job_type: z.enum(["find_creators", "manage_outreach", "be_a_creator", "other"]).catch("other"),
  platform: z.enum(["instagram", "tiktok", "both", "unknown"]).catch("unknown"),
  focus: z.enum(["ugc", "affiliate"]).catch("ugc"),
  niche: z.string().catch(""),
  creators_needed: Quoted(z.number().nullable().catch(null)).catch({ value: null, quote: null }),
  followers: z.object({ min: z.number().nullable().catch(null), max: z.number().nullable().catch(null), quote: z.string().nullable().catch(null) })
    .catch({ min: null, max: null, quote: null }),
  budget: z.object({ amount: z.number().nullable().catch(null), kind: z.enum(["fixed", "hourly", "unknown"]).catch("unknown"), quote: z.string().nullable().catch(null) })
    .catch({ amount: null, kind: "unknown", quote: null }),
  requirements: z.array(z.object({ text: z.string().catch(""), quote: z.string().catch("") })).catch([]),
  red_flags: z.array(z.object({ text: z.string().catch(""), quote: z.string().catch("") })).catch([]),
  questions: z.array(z.string()).catch([]),
});
export type JobRaw = z.infer<typeof JobSchema>;

const JOB_SYSTEM = `You read a freelance job post (Upwork or similar) for a specialist who FINDS and VETS social media creators for brands and can run outreach to them. ${GUARD}
Return ONLY JSON:
{
 "title": "short English title, max 8 words",
 "summary_uk": "2-3 sentences in Ukrainian: what exactly the client wants, how many creators, deliverables, deadline",
 "job_type": "find_creators (they need someone to find/list/vet creators) | manage_outreach (contact creators, negotiate, manage a creator program) | be_a_creator (they want a creator to make content themselves) | other",
 "platform": "instagram | tiktok | both | unknown",
 "focus": "ugc (content for brand ads) | affiliate (creators who promote with links, codes, storefronts)",
 "niche": "the product niche in 1-4 English words",
 "creators_needed": {"value": number or null, "quote": "verbatim words from the post with that number"},
 "followers": {"min": number or null, "max": number or null, "quote": "verbatim words with the follower range, e.g. 5k-60k followers"},
 "budget": {"amount": number or null, "kind": "fixed | hourly | unknown", "quote": "verbatim words from the post with the amount"},
 "requirements": [{"text": "short English requirement", "quote": "verbatim words from the post"}],
 "red_flags": [{"text": "short Ukrainian warning", "quote": "verbatim words from the post"}],
 "questions": ["1-2 short clarifying questions in simple English the freelancer can ask the client"]
}
Red flags: contact or payment outside the platform, unpaid test work, paying to apply, very vague task, unrealistic volume for the budget.
Quotes must be copied exactly from the post. If something is not in the post, use null or an empty list.`;

const digits = (s: string) => s.replace(/[^\d]/g, "");

/** Тривожні ознаки, які код бачить сам — без моделі. */
const CODE_FLAGS: [RegExp, string][] = [
  [/\b(whats\s?app|telegram|skype|discord|wechat)\b[^.\n]{0,60}/i, "Просять перейти в месенджер — до контракту це заборонено правилами Upwork, і так часто діють шахраї"],
  [/\b(e-?mail me|gmail\.com|contact me (directly )?at|outside (of )?upwork|off[- ]platform)\b[^.\n]{0,60}/i, "Контакт або оплата поза платформою — ризик бану й неоплати"],
  [/\b(unpaid|for free|free (test|trial|sample)|no pay)\b[^.\n]{0,60}/i, "Безкоштовне тестове завдання — погоджуйтесь лише на маленьке (2–3 автори), не на весь список"],
  [/\b(pay|deposit|fee)\b[^.\n]{0,30}\b(to apply|to start|for training|registration)\b[^.\n]{0,40}/i, "Просять заплатити, щоб почати — типова схема шахрайства"],
];

export function codeRedFlags(text: string): { text: string; quote: string }[] {
  const out: { text: string; quote: string }[] = [];
  for (const [re, note] of CODE_FLAGS) {
    const m = text.match(re);
    if (m) out.push({ text: note, quote: m[0].trim().slice(0, 120) });
  }
  return out;
}

/** Перевірений розбір: числа й ознаки — лише з цитатами, які справді є в тексті замовлення. */
export function groundJob(raw: JobRaw, text: string): JobAnalysis {
  let dropped = 0;
  const quoted = (q: string | null, n: number) => {
    const ok = !!q && quoteFound(q, text) && digits(q).includes(digits(String(Math.round(n))));
    if (!ok) dropped++;
    return ok;
  };
  const creatorsNeeded = raw.creators_needed.value != null && raw.creators_needed.value > 0 && quoted(raw.creators_needed.quote, raw.creators_needed.value)
    ? { count: Math.round(raw.creators_needed.value), quote: raw.creators_needed.quote! } : null;
  const budget = raw.budget.amount != null && raw.budget.amount > 0 && quoted(raw.budget.quote, raw.budget.amount)
    ? { amount: raw.budget.amount, kind: raw.budget.kind, quote: raw.budget.quote! } : null;
  // Діапазон підписників: кожне число має стояти в цитаті («5k» = 5000).
  let followers: JobAnalysis["followers"] = null;
  const fq = raw.followers.quote;
  if ((raw.followers.min != null || raw.followers.max != null) && fq && quoteFound(fq, text)) {
    const inQuote = expandCounts(fq);
    const ok = (n: number | null) => n == null || (n >= 0 && inQuote.includes(Math.round(n)));
    if (ok(raw.followers.min) && ok(raw.followers.max)) followers = { min: raw.followers.min, max: raw.followers.max, quote: fq };
    else dropped++;
  } else if (raw.followers.min != null || raw.followers.max != null) dropped++;
  const keep = (list: { text: string; quote: string }[], max: number) => list.filter((x) => {
    const ok = x.text.trim().length > 2 && quoteFound(x.quote, text);
    if (!ok) dropped++;
    return ok;
  }).slice(0, max).map((x) => ({ text: x.text.trim().slice(0, 200), quote: x.quote.trim().slice(0, 200) }));
  const flags = [...keep(raw.red_flags, 5)];
  for (const f of codeRedFlags(text)) if (!flags.some((x) => normalize(x.quote).includes(normalize(f.quote).slice(0, 20)))) flags.push(f);
  return {
    title: (raw.title.trim() || text.trim().split("\n")[0]).slice(0, 80),
    summaryUk: raw.summary_uk.trim().slice(0, 600),
    jobType: raw.job_type, platform: raw.platform, focus: raw.focus, niche: raw.niche.trim().slice(0, 60),
    creatorsNeeded, budget, followers,
    requirements: keep(raw.requirements, 6),
    redFlags: flags,
    questions: raw.questions.map((q) => q.trim()).filter((q) => q.length > 5 && q.length < 200).slice(0, 2),
    dropped,
  };
}

/** Числа з тексту з урахуванням «5k», «1.5M», «10 000». */
export function expandCounts(s: string): number[] {
  return [...s.replace(/(\d)[ ,](?=\d{3}\b)/g, "$1").matchAll(/(\d+(?:\.\d+)?)\s*([kKmM]|тис)?/g)].map((m) => {
    const n = Number(m[1]);
    const mul = !m[2] ? 1 : /m/i.test(m[2]) ? 1_000_000 : 1000;
    return Math.round(n * mul);
  });
}

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ");

export async function analyzeJob(db: Db, text: string): Promise<JobAnalysis> {
  const r = await chatJsonMeta(db, JobSchema, [
    { role: "system", content: JOB_SYSTEM },
    { role: "user", content: dataBlock("job_post", text.slice(0, 6000)) },
  ], { purpose: "pitch-job", maxTokens: 900 });
  return groundJob(r.data, text);
}

export type Fit = { level: "good" | "maybe" | "skip"; notes: string[] };

/** Чи варто відгукуватися — вирішує код за розбором, а не модель. */
export function jobFit(a: JobAnalysis): Fit {
  const notes: string[] = [];
  let level: Fit["level"] = "good";
  const lower = (to: Fit["level"]) => {
    if (to === "skip" || (to === "maybe" && level === "good")) level = to;
  };
  if (a.jobType === "be_a_creator") {
    lower("skip");
    notes.push("Шукають самого автора, який зніме контент, а не того, хто знайде авторів. Відгукуйтесь, лише якщо пропонуєте замість цього знайти їм кількох авторів");
  } else if (a.jobType === "other") {
    lower("maybe");
    notes.push("Завдання не схоже на пошук авторів чи переписку з ними — перечитайте, чи це ваша робота");
  } else {
    notes.push(a.jobType === "find_creators" ? "Пошук і відбір авторів — саме те, що робить інструмент" : "Переписка з авторами й ведення програми — інструмент веде листування за правилами клієнта");
  }
  if (a.platform !== "instagram" && a.platform !== "tiktok" && a.platform !== "both") notes.push("Платформу не названо — уточніть у питанні");
  if (a.budget) {
    const low = a.budget.kind === "hourly" ? a.budget.amount < 8 : a.budget.kind === "fixed" ? a.budget.amount < 30 : false;
    if (low) {
      lower("maybe");
      notes.push(`Бюджет дуже малий (${a.budget.kind === "hourly" ? `$${a.budget.amount}/год` : `$${a.budget.amount}`}) — беріть, лише якщо потрібен перший відгук`);
    }
  }
  if (a.creatorsNeeded && a.creatorsNeeded.count > 100) {
    lower("maybe");
    notes.push(`Великий обсяг (${a.creatorsNeeded.count} авторів) — запропонуйте почати з першої партії`);
  }
  if (a.redFlags.length) {
    lower(a.redFlags.some((f) => /шахрай|заплатити/i.test(f.text)) ? "skip" : "maybe");
    notes.push(`Тривожні ознаки: ${a.redFlags.length}`);
  }
  return { level, notes };
}

/* ---------- 2. автори-приклади ---------- */

/** Що в причинах відбору можна сказати замовнику англійською (без email і без внутрішніх оцінок). */
const REASON_EN: [RegExp, string][] = [
  [/називає себе UGC-креатором/, "UGC creator"],
  [/відкритий до співпраці/, "open to collabs"],
  [/є портфоліо/, "has a portfolio"],
  [/публікував цього тижня/, "posted this week"],
  [/огляди й розпаковки/, "films reviews and unboxings"],
  [/партнерки:/, "already does affiliate"],
];

export function sampleWhy(reasons: string[]): string | null {
  const out: string[] = [];
  for (const r of reasons) {
    const niche = r.match(/^ніш[аі]: (.+)$/);
    if (niche && !out.some((x) => x.startsWith("niche"))) out.push(`niche: ${niche[1].replace(/\S+@\S+/g, "").slice(0, 60)}`);
    for (const [re, en] of REASON_EN) if (re.test(r) && !out.includes(en)) out.push(en);
  }
  return out.length ? out.slice(0, 4).join(", ") : null;
}

export const shortCount = (n: number | null) =>
  n == null ? null : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);

const MIN_SAMPLE_FOLLOWERS = 1000;

export type SampleOption = PitchSample & { score: number; lead: boolean };

/** Кращі автори пошуку: спершу готові ліди, потім за загальною оцінкою. */
export async function sampleOptions(db: Db, searchId: number, limit = 15, range?: JobAnalysis["followers"]): Promise<SampleOption[]> {
  const all = await db.select({ cand: searchCandidates, c: creators }).from(searchCandidates)
    .innerJoin(creators, eq(creators.id, searchCandidates.creatorId))
    .where(and(eq(searchCandidates.searchId, searchId), inArray(searchCandidates.stage, ["qualified", "shortlisted"])))
    .orderBy(desc(searchCandidates.lead), desc(searchCandidates.score)).limit(200);
  // Приклад з кількома сотнями підписників не переконає замовника; ті, що в його діапазоні, — першими.
  const inRange = (f: number | null) => f != null && (range?.min == null || f >= range.min) && (range?.max == null || f <= range.max);
  const rows = all.filter(({ c }) => c.followers == null || c.followers >= MIN_SAMPLE_FOLLOWERS)
    .map((r, i) => ({ r, i, ok: range ? inRange(r.c.followers) : true }))
    .sort((a, b) => Number(b.ok) - Number(a.ok) || a.i - b.i).slice(0, limit).map((x) => x.r);
  return rows.map(({ cand, c }) => ({
    creatorId: c.id, handle: c.username, platform: c.platform, url: profileUrl(c.platform, c.username),
    followers: c.followers, followersShort: shortCount(c.followers), erPct: c.erLikes != null ? `${(c.erLikes * 100).toFixed(1)}%` : null,
    country: c.country, hasEmail: c.emails.length > 0, why: sampleWhy(cand.reasons), score: Math.round(cand.score), lead: cand.lead,
  }));
}

/** Список для вкладення у відгук: посилання й цифри, без контактів. */
export function sampleList(samples: PitchSample[]): string {
  return samples.map((s) => [
    `@${s.handle} — ${s.url}`,
    [s.followersShort && `${s.followersShort} followers`, s.erPct && `${s.erPct} engagement`, s.country, s.hasEmail && "contact found", s.why]
      .filter(Boolean).join(", "),
  ].filter(Boolean).join("\n  ")).join("\n");
}

/* ---------- 3. відгук ---------- */

export type ProposalFacts = {
  freelancer: { name: string; about: string; offer: string };
  job: { title: string; niche: string; platform: string; requirements: string[]; creators_needed: number | null; questions: string[] };
  samples: { handle: string; url: string; followers?: string; engagement?: string; country?: string; why?: string }[];
};

export function proposalFacts(a: JobAnalysis, profile: PitchProfile, samples: PitchSample[]): ProposalFacts {
  return {
    // Зразки стилю — не факти: числа й імена з них у відгук не потраплять.
    freelancer: { name: profile.name, about: profile.about, offer: profile.offer },
    job: {
      title: a.title, niche: a.niche, platform: a.platform, requirements: a.requirements.map((r) => r.text),
      creators_needed: a.creatorsNeeded?.count ?? null, questions: a.questions,
    },
    // Порожні поля не передаємо: інакше модель пише в тексті «null».
    samples: samples.map((s) => Object.fromEntries(Object.entries({
      handle: `@${s.handle}`, url: s.url, followers: s.followersShort, engagement: s.erPct, country: s.country, why: s.why,
    }).filter(([, v]) => v != null)) as ProposalFacts["samples"][number]),
  };
}

const ProposalSchema = z.object({ proposal: z.string(), translation_uk: z.string().catch("") });

const PROPOSAL_SYSTEM = `You write a short reply to a freelance job post, as the freelancer: someone who finds and vets social media creators for brands. Simple, clear English. ${GUARD}
It should read like a quick personal note from a real person who actually read the post, not a template:
- Open with the client's actual need in your own words (from FACTS.job), no greeting formula and no "Dear Hiring Manager".
- Say briefly how you'd do it, using ONLY FACTS.freelancer.about and FACTS.freelancer.offer.
- If FACTS.samples is not empty, mention you already looked and found a few creators, then one line per sample starting with "- ": "@handle (url) - followers, engagement, why". Use the values exactly as given.
- If FACTS.job.questions has something, ask one (at most two) of them naturally.
- End with just the name from FACTS.freelancer.name.
Rules:
- Never invent experience, past clients, results, reviews, years, prices or any number not in FACTS or the job post.
- Follow the client's numbers: if FACTS.job.creators_needed is set, offer exactly that many creators, even if FACTS.freelancer.offer names another count.
- Do not name a price: the platform shows the bid separately. Mention a rate only if the job post asks for it, and then only a price from FACTS.freelancer.offer.
- If the post asks to start the reply with a word or include a code word, do it.
- Never write email addresses or phone numbers. No emojis.
- 60-150 words. Blank line between paragraphs.
${HUMAN_RULES}
Also return a full Ukrainian translation so the freelancer understands it.
Return ONLY JSON: {"proposal": "...", "translation_uk": "..."}`;

const URL_RE = /https?:\/\/[^\s)>\]]+/gi;
const HANDLE = /(?<![\w.])@[a-z0-9._]{2,30}/gi;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/gi;

/** Перевірка відгуку: числа, посилання й @імена — лише з фактів і тексту замовлення; email і телефонів — немає. */
export function checkProposal(body: string, facts: ProposalFacts, jobText: string): string[] {
  const issues: string[] = [];
  const allowedText = `${JSON.stringify(facts)}\n${jobText}`.toLowerCase();
  const allowed = numTokens(allowedText);
  const noUrls = body.replace(URL_RE, " ");
  for (const n of numTokens(noUrls.replace(EMAIL, " "))) if (!allowed.has(n)) issues.push(`число «${n}» відсутнє у фактах`);
  for (const u of new Set((body.match(URL_RE) ?? []).map((x) => x.replace(/[.,]+$/, "").toLowerCase()))) if (!allowedText.includes(u)) issues.push(`посилання ${u} відсутнє у фактах`);
  const handles = new Set(facts.samples.map((s) => s.handle.toLowerCase()));
  for (const h of new Set((noUrls.replace(EMAIL, " ").match(HANDLE) ?? []).map((x) => x.toLowerCase().replace(/\.+$/, "")))) {
    if (!handles.has(h) && !allowedText.includes(h)) issues.push(`ім’я ${h} відсутнє серед знайдених авторів`);
  }
  if (EMAIL.test(body)) issues.push("у відгуку є email — контакти до замовлення не даємо (і Upwork це забороняє)");
  EMAIL.lastIndex = 0;
  if (looksLikePhone(noUrls)) issues.push("у відгуку схоже на номер телефону");
  if (/\{\{|\}\}/.test(body)) issues.push("у відгуку лишився шаблон {{…}}");
  if (/\b(null|undefined|NaN)\b/.test(body)) issues.push("у відгуку є службове слово null/undefined");
  const lang = detectLanguage(body).language;
  if (lang && lang !== "en") issues.push(`відгук написано не англійською (${lang})`);
  if (body.split(/\s+/).length > 230) issues.push("відгук задовгий — замовники читають перші рядки");
  for (const s of facts.samples) if (!body.toLowerCase().includes(s.handle.toLowerCase())) {
    issues.push(`немає прикладу ${s.handle}`);
    break;
  }
  return [...new Set(issues)];
}

/** Модель інколи зливає все в один абзац: кожен приклад — з нового рядка. */
export const tidy = (body: string) => body.replace(/\r\n/g, "\n").replace(/[ \t]+- (?=@)/g, "\n- ").replace(/\n{3,}/g, "\n\n").trim();

export async function writeProposal(db: Db, facts: ProposalFacts, jobText: string, style: string[] = []): Promise<{ proposal: string; translationUk: string; issues: string[] }> {
  const messages = [
    { role: "system" as const, content: PROPOSAL_SYSTEM },
    { role: "user" as const, content: `FACTS (trusted):\n${JSON.stringify(facts, null, 1)}\n${styleBlock(style)}\n${dataBlock("job_post", jobText.slice(0, 4000))}` },
  ];
  // Безпечні виправлення (тире, порожні фрази) — одразу; решту ІІ-ознак і помилок модель виправляє сама один раз.
  const review = (raw: string) => {
    const text = humanize(tidy(raw));
    return { text, issues: [...checkProposal(text, facts, jobText), ...tellIssues(text)] };
  };
  let res = await chatJsonMeta(db, ProposalSchema, messages, { purpose: "pitch-proposal", maxTokens: 900, cache: false });
  let r = review(res.data.proposal);
  if (r.issues.length) {
    const retry = await chatJsonMeta(db, ProposalSchema, [
      ...messages, { role: "assistant", content: JSON.stringify(res.data) },
      { role: "user", content: `Fix these problems and return the full corrected JSON: ${r.issues.join("; ")}. Remove anything not in FACTS. Keep it sounding like a real person.` },
    ], { purpose: "pitch-proposal", maxTokens: 900, cache: false });
    const again = review(retry.data.proposal);
    if (again.issues.length < r.issues.length) {
      res = retry;
      r = again;
    }
  }
  return { proposal: r.text, translationUk: res.data.translation_uk.trim(), issues: r.issues };
}

/** Ваші зразки + відгуки, на які замовники відповіли: так тон з часом підлаштовується під те, що працює. */
export async function styleSamples(db: Db, profile: PitchProfile): Promise<string[]> {
  const own = (profile.style ?? "").split(/\n\s*-{3,}\s*\n/).map((x) => x.trim()).filter((x) => x.length > 20);
  const won = await db.select({ proposal: jobPitches.proposal }).from(jobPitches)
    .where(inArray(jobPitches.status, ["replied", "won"])).orderBy(desc(jobPitches.updatedAt)).limit(2);
  return [...own.slice(0, 3), ...won.map((w) => w.proposal ?? "").filter(Boolean)].slice(0, 4);
}

/* ---------- усе разом ---------- */

export type PitchInput = { jobText: string; profile: PitchProfile; platform?: "auto" | "instagram" | "tiktok"; search?: boolean };

/** Невеликий дешевий пошук прикладів під нішу замовника: 5 готових лідів — і стоп. */
export async function createSampleSearch(db: Db, a: JobAnalysis, jobText: string, platform: "instagram" | "tiktok"): Promise<{ id: number | null; note: string | null }> {
  const s = await suggestFromBrief(db, jobText, a.focus);
  const sources = { bioQueries: s.bioQueries, competitors: s.competitors, seeds: [], places: [], webQueries: [], usernames: [] };
  if (platform === "instagram" && !s.hashtags.length && !s.bioQueries.length && !s.competitors.length) {
    return { id: null, note: "Модель не запропонувала хештегів чи запитів — створіть пошук вручну" };
  }
  const [row] = await db.insert(searches).values({
    name: `Відгук: ${a.title}`.slice(0, 80), platform, focus: a.focus, brief: jobText.slice(0, 4000),
    outreachLanguage: "en", hashtags: s.hashtags, keywords: s.keywords, stopWords: s.stopWords, sources,
    countries: s.countries, languages: s.languages,
    minFollowers: a.followers?.min ?? null, maxFollowers: a.followers?.max ?? null,
    postsPerTag: 30, maxProfiles: 40, auditLimit: 10, deepLimit: 0, commentsLimit: 0, targetLeads: SAMPLE_COUNT, budgetUsd: 3,
  }).returning({ id: searches.id });
  return { id: row.id, note: null };
}

export async function createPitch(db: Db, input: PitchInput): Promise<{ id: number; notes: string[] }> {
  const jobText = input.jobText.trim();
  const a = await analyzeJob(db, jobText);
  const notes: string[] = [];
  let searchId: number | null = null;
  if (input.search !== false && jobFit(a).level !== "skip") {
    const platform = input.platform && input.platform !== "auto" ? input.platform : a.platform === "tiktok" ? "tiktok" : "instagram";
    try {
      const r = await createSampleSearch(db, a, jobText, platform);
      searchId = r.id;
      if (r.note) notes.push(r.note);
    } catch (e) {
      notes.push(`Пошук прикладів не створено: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
    }
  }
  const w = await writeProposal(db, proposalFacts(a, input.profile, []), jobText, await styleSamples(db, input.profile));
  const [row] = await db.insert(jobPitches).values({
    title: a.title, jobText, profile: input.profile, analysis: a, proposal: w.proposal, proposalUk: w.translationUk, issues: w.issues, searchId,
  }).returning({ id: jobPitches.id });
  return { id: row.id, notes };
}

/** Переписати відгук з вибраними авторами: null — 5 найкращих з пошуку, [] — без авторів. */
export async function rewritePitch(db: Db, pitch: JobPitch, creatorIds: number[] | null = null): Promise<{ issues: string[]; samples: number }> {
  if (!pitch.analysis) throw new Error("Немає розбору замовлення");
  let samples: PitchSample[] = [];
  if (pitch.searchId && (creatorIds == null || creatorIds.length)) {
    const opts = await sampleOptions(db, pitch.searchId, 30, pitch.analysis.followers);
    samples = (creatorIds ? opts.filter((o) => creatorIds.includes(o.creatorId)) : opts).slice(0, SAMPLE_COUNT)
      .map(({ score: _s, lead: _l, ...s }) => s);
  }
  const w = await writeProposal(db, proposalFacts(pitch.analysis, pitch.profile, samples), pitch.jobText, await styleSamples(db, pitch.profile));
  await db.update(jobPitches).set({ proposal: w.proposal, proposalUk: w.translationUk, issues: w.issues, samples, updatedAt: new Date() })
    .where(eq(jobPitches.id, pitch.id));
  return { issues: w.issues, samples: samples.length };
}

/* ---------- кілька замовлень разом ---------- */

/** Розділювач між замовленнями у вставленому тексті: рядок з ---, === або ***. */
export function splitJobs(text: string): string[] {
  return text.split(/\n\s*(?:-{3,}|={3,}|\*{3,})\s*\n/).map((x) => x.trim()).filter((x) => x.length >= 80).slice(0, 20);
}

/** Кілька замовлень — у чергу: розбирає фоновий виконавець по одному, коли модель вільна (ліміти безкоштовних ключів). */
export async function queuePitches(db: Db, texts: string[], profile: PitchProfile, options: PitchOptions): Promise<number> {
  if (!texts.length) return 0;
  await db.insert(jobPitches).values(texts.map((t) => ({
    title: t.split("\n")[0].trim().slice(0, 80) || "Замовлення", jobText: t.slice(0, 8000), profile, options,
  })));
  return texts.length;
}

/** Крок фонового виконавця: наступний відгук із черги. Пошук прикладів — лише для тих, за які варто братися. */
export async function runPitchQueue(db: Db): Promise<boolean> {
  const [p] = await db.select().from(jobPitches).where(and(isNull(jobPitches.analysis), isNotNull(jobPitches.options))).orderBy(asc(jobPitches.id)).limit(1);
  if (!p) return false;
  const opts = p.options ?? { platform: "auto", search: true };
  let a: JobAnalysis;
  try {
    a = await analyzeJob(db, p.jobText);
  } catch (e) {
    // Модель зайнята — спробуємо наступного разу; інша помилка — знімаємо з черги, щоб не блокувала решту.
    if (e instanceof LlmUnavailableError) return false;
    await db.update(jobPitches).set({ options: null, issues: [`Не вдалося розібрати: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`] }).where(eq(jobPitches.id, p.id));
    return true;
  }
  let searchId: number | null = null;
  if (opts.search && jobFit(a).level === "good") {
    const platform = opts.platform !== "auto" ? opts.platform : a.platform === "tiktok" ? "tiktok" : "instagram";
    searchId = (await createSampleSearch(db, a, p.jobText, platform).catch(() => ({ id: null }))).id;
  }
  const w = await writeProposal(db, proposalFacts(a, p.profile, []), p.jobText, await styleSamples(db, p.profile));
  await db.update(jobPitches).set({
    title: a.title, analysis: a, proposal: w.proposal, proposalUk: w.translationUk, issues: w.issues, searchId, updatedAt: new Date(),
  }).where(eq(jobPitches.id, p.id));
  return true;
}

/** Ваші дані з останнього відгуку — щоб не вводити їх щоразу. */
export async function lastProfile(db: Db): Promise<PitchProfile | null> {
  const [p] = await db.select({ profile: jobPitches.profile }).from(jobPitches).orderBy(desc(jobPitches.id)).limit(1);
  return p?.profile ?? null;
}
