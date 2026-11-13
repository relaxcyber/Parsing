"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db/client";
import { creators, searches, searchTemplates, type ContentFormat, type CriterionMode, type OutreachStatus } from "@/db/schema";
import { normalizeCountry } from "@/enrich/geo";
import { requireAuth } from "@/lib/auth";
import { LlmUnavailableError } from "@/llm/client";
import { generateDraft } from "@/outreach/draft";
import { suggestFromBrief, type BriefSuggestion } from "@/search/brief";
import { DEFAULT_CRITERIA } from "@/search/criteria";
import { suppressCreator } from "@/search/suppress";

const split = (v: unknown) => String(v ?? "").split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
const tags = (max: number) => z.unknown().transform((v) => [...new Set(split(v).map((s) => s.replace(/^#/, "").toLowerCase()))].slice(0, max));
const lines = (max: number) => z.unknown().transform((v) => [...new Set(split(v))].slice(0, max));
const handles = (max: number) => z.unknown().transform((v) =>
  [...new Set(split(v).map((s) => s.replace(/^@/, "").replace(/^https?:\/\/(www\.|m\.)?(instagram\.com\/|tiktok\.com\/@)/i, "").replace(/[/?#].*$/, "").toLowerCase()).filter((s) => /^[a-z0-9._]{2,30}$/.test(s)))].slice(0, max));
const optionalInt = z.preprocess((v) => (v === "" || v == null ? null : v), z.coerce.number().int().nonnegative().nullable());
const optionalNum = z.preprocess((v) => (v === "" || v == null ? null : String(v).replace(",", ".")), z.coerce.number().nonnegative().nullable());
const text = (max: number) => z.preprocess((v) => (v == null ? "" : String(v).trim()), z.string().max(max)).transform((v) => v || null);
const mode = z.enum(["required", "preferred", "off"]).catch("off");
const weight = z.coerce.number().min(0).max(3).catch(1);

const SearchForm = z.object({
  name: z.string().trim().min(2).max(80),
  focus: z.enum(["ugc", "affiliate"]),
  platform: z.enum(["instagram", "tiktok"]).catch("instagram"),
  brief: text(4000), brandName: text(80), offer: text(1000), letterExample: text(3000),
  outreachLanguage: z.enum(["en", "uk", "ru", "pl", "de", "es"]),
  hashtags: tags(10), keywords: tags(20), stopWords: tags(30),
  bioQueries: lines(5), competitors: handles(5), seeds: handles(10), places: lines(5), webQueries: lines(5), usernames: handles(300),
  postsPerTag: z.coerce.number().int().min(5).max(200),
  maxProfiles: z.coerce.number().int().min(1).max(500),
  minFollowers: optionalInt, maxFollowers: optionalInt,
  countries: z.unknown().transform((v) => [...new Set(split(v).flatMap((c) => c.split(/\s+/)).map(normalizeCountry).filter((c) => /^[A-Z]{2}$/.test(c)))].slice(0, 20)),
  languages: z.unknown().transform((v) => [...new Set(split(v).flatMap((c) => c.split(/\s+/)).map((c) => c.toLowerCase()).filter((c) => /^[a-z]{2}$/.test(c)))].slice(0, 10)),
  auditLimit: z.coerce.number().int().min(0).max(150),
  deepLimit: z.coerce.number().int().min(0).max(50),
  commentsLimit: z.coerce.number().int().min(0).max(50),
  targetLeads: optionalInt, budgetUsd: optionalNum, repeatDays: optionalInt, clientId: optionalInt,
  excludeContacted: z.unknown().transform((v) => v === "on"),
  "c.followers": mode, "c.country": mode, "c.language": mode, "c.activity": mode, "c.er": mode, "c.email": mode, "c.ads": mode, "c.trust": mode, "c.formats": mode,
  activityDays: z.coerce.number().int().min(1).max(365).catch(DEFAULT_CRITERIA.activity.days),
  erMinPct: z.coerce.number().min(0).max(50).catch(DEFAULT_CRITERIA.er.minPct),
  trustMaxRisk: z.enum(["low", "medium"]).catch("medium"),
  qualityMin: z.coerce.number().int().min(0).max(100).catch(DEFAULT_CRITERIA.quality.min),
  qualityLead: z.coerce.number().int().min(0).max(100).catch(DEFAULT_CRITERIA.quality.lead),
  "w.fit": weight, "w.quality": weight, "w.readiness": weight, "w.trust": weight, "w.match": weight,
});

const FORMATS: ContentFormat[] = ["talking_to_camera", "product_demo", "voiceover", "subtitles"];

export async function createSearch(form: FormData) {
  await requireAuth();
  const parsed = SearchForm.safeParse(Object.fromEntries(form));
  const d = parsed.data;
  const sources = d && { bioQueries: d.bioQueries, competitors: d.competitors, seeds: d.seeds, places: d.places, webQueries: d.webQueries, usernames: d.usernames };
  // TikTok шукає ще й серед TikTok-акаунтів вашої бази Instagram — джерело є завжди.
  if (!d || !sources || (d.platform !== "tiktok" && d.hashtags.length === 0 && !Object.values(sources).some((x) => x.length))) {
    redirect(`/search?msg=${encodeURIComponent("Перевірте форму: потрібні назва і хоча б одне джерело (хештег, запит, бренд, зразок, місце чи список імен)")}`);
  }
  const formats = form.getAll("formats").map(String).filter((f): f is ContentFormat => FORMATS.includes(f as ContentFormat));
  const m = (k: keyof typeof d) => d[k] as CriterionMode;
  const [row] = await getDb().insert(searches).values({
    name: d.name, platform: d.platform, focus: d.focus, brief: d.brief, brandName: d.brandName, offer: d.offer, letterExample: d.letterExample,
    outreachLanguage: d.outreachLanguage, hashtags: d.hashtags, keywords: d.keywords, stopWords: d.stopWords, sources,
    postsPerTag: d.postsPerTag, maxProfiles: d.maxProfiles, minFollowers: d.minFollowers, maxFollowers: d.maxFollowers,
    countries: d.countries, languages: d.languages, auditLimit: d.auditLimit, deepLimit: d.deepLimit, commentsLimit: d.commentsLimit,
    clientId: d.clientId || null, targetLeads: d.targetLeads || null, budgetUsd: d.budgetUsd || null, repeatDays: d.repeatDays || null, excludeContacted: d.excludeContacted,
    criteria: {
      followers: m("c.followers"), country: m("c.country"), language: m("c.language"),
      activity: { mode: m("c.activity"), days: d.activityDays }, er: { mode: m("c.er"), minPct: d.erMinPct },
      email: m("c.email"), ads: m("c.ads"), trust: { mode: m("c.trust"), maxRisk: d.trustMaxRisk },
      formats: { mode: formats.length ? m("c.formats") : "off", list: formats },
      quality: { min: d.qualityMin, lead: Math.max(d.qualityLead, d.qualityMin) },
    },
    weights: { fit: d["w.fit"], quality: d["w.quality"], readiness: d["w.readiness"], trust: d["w.trust"], match: d["w.match"] },
  }).returning({ id: searches.id });
  redirect(`/search/${row.id}`);
}

export type SuggestResult = { ok: true; data: BriefSuggestion } | { ok: false; error: string };

/** Пропозиція параметрів з брифу (кнопка «Заповнити з брифу»). */
export async function suggestBrief(brief: string, focus: "ugc" | "affiliate"): Promise<SuggestResult> {
  await requireAuth();
  if (brief.trim().length < 20) return { ok: false, error: "Опишіть бриф хоча б одним-двома реченнями" };
  try {
    return { ok: true, data: await suggestFromBrief(getDb(), brief, focus === "affiliate" ? "affiliate" : "ugc") };
  } catch (e) {
    return { ok: false, error: e instanceof LlmUnavailableError ? "Мовна модель зараз недоступна — спробуйте пізніше" : `Не вдалося: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}` };
  }
}

export async function saveTemplate(name: string, data: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
  await requireAuth();
  const n = name.trim().slice(0, 60);
  if (n.length < 2) return { ok: false, error: "Назвіть шаблон" };
  const { name: _skip, ...rest } = data;
  await getDb().insert(searchTemplates).values({ name: n, data: rest }).onConflictDoUpdate({ target: searchTemplates.name, set: { data: rest } });
  revalidatePath("/search");
  return { ok: true };
}

export async function deleteTemplate(form: FormData) {
  await requireAuth();
  await getDb().delete(searchTemplates).where(eq(searchTemplates.id, z.coerce.number().int().positive().parse(form.get("id"))));
  redirect(`/search?msg=${encodeURIComponent("Шаблон видалено")}`);
}

const id = (form: FormData) => z.coerce.number().int().positive().parse(form.get("id"));
const back = (form: FormData, fallback: string) => {
  const to = String(form.get("back") ?? "");
  return to.startsWith("/") && !to.startsWith("//") ? to : fallback;
};

export async function cancelSearch(form: FormData) {
  await requireAuth();
  const searchId = id(form);
  await getDb().update(searches).set({ status: "cancelled", finishedAt: new Date() }).where(eq(searches.id, searchId));
  redirect(`/search/${searchId}`);
}

export async function rerunSearch(form: FormData) {
  await requireAuth();
  const searchId = id(form);
  const db = getDb();
  const [s] = await db.select().from(searches).where(eq(searches.id, searchId));
  if (s && s.status !== "running" && s.status !== "queued") {
    await db.update(searches).set({ status: "queued", error: null, progress: null, finishedAt: null }).where(eq(searches.id, searchId));
  }
  redirect(`/search/${searchId}`);
}

export async function deleteSearch(form: FormData) {
  await requireAuth();
  await getDb().delete(searches).where(eq(searches.id, id(form)));
  redirect(`/search?msg=${encodeURIComponent("Пошук видалено")}`);
}

/** Видалити автора й більше ніколи його не збирати (запит на видалення даних). */
export async function suppress(form: FormData) {
  await requireAuth();
  await suppressCreator(getDb(), id(form), "видалено вручну з дашборда");
  redirect(back(form, "/search"));
}

/** Ваш вердикт щодо автора: еталон, за яким калібруються пороги моделі. Повторний клік знімає позначку. */
export async function setVerdict(form: FormData) {
  await requireAuth();
  const verdict = z.enum(["yes", "no"]).parse(form.get("verdict"));
  const db = getDb();
  const [c] = await db.select({ v: creators.manualVerdict }).from(creators).where(eq(creators.id, id(form)));
  if (c) await db.update(creators).set({ manualVerdict: c.v === verdict ? null : verdict }).where(eq(creators.id, id(form)));
  redirect(back(form, "/search"));
}

/** Статус роботи з автором: написали, відповів, у роботі, відмова. */
export async function setOutreachStatus(form: FormData) {
  await requireAuth();
  const status = z.enum(["new", "contacted", "replied", "in_work", "posted", "declined"]).parse(form.get("status")) as OutreachStatus;
  const note = String(form.get("note") ?? "").trim().slice(0, 500) || null;
  await getDb().update(creators).set({ outreachStatus: status, outreachAt: new Date(), ...(form.has("note") ? { outreachNote: note } : {}) })
    .where(eq(creators.id, id(form)));
  redirect(back(form, `/creators/${id(form)}`));
}

export async function createDraft(form: FormData) {
  await requireAuth();
  const creatorId = id(form);
  const searchId = Number(form.get("searchId")) || null;
  let msg: string;
  try {
    const r = await generateDraft(getDb(), creatorId, searchId);
    msg = r.issues.length ? `Чернетку створено, але перевірка знайшла проблеми: ${r.issues.join("; ")}` : "Чернетку створено й перевірено";
  } catch (e) {
    msg = e instanceof LlmUnavailableError ? "Мовна модель зараз недоступна — спробуйте пізніше" : `Не вдалося: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`;
  }
  redirect(`/creators/${creatorId}?msg=${encodeURIComponent(msg)}${searchId ? `&search=${searchId}` : ""}#drafts`);
}
