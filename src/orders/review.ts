import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { contentItems, creators, orders, searchCandidates, type Order, type OrderSpec, type ReviewItem } from "@/db/schema";
import { chatJsonMeta, dataBlock, GUARD } from "@/llm/client";
import { quoteFound } from "@/llm/evidence";
import { profileUrl } from "@/lib/profile-url";
import { toCsv } from "@/search/csv";

/**
 * Перевірка списку перед здачею клієнту — замість того, щоб ви переглядали кожного автора:
 *  1. код відсіює явне: агентства й магазини, підписників поза діапазоном, чужу країну;
 *  2. модель дивиться біо й підписи до дописів і каже «підходить / ні / сумнівно» з дослівною цитатою;
 *     без цитати — «сумнівно» (такий автор чекає вашого рішення, а не йде клієнту навмання);
 *  3. до клієнта йдуть лише «підходить» — з коротким поясненням англійською.
 */

export const REVIEW_BATCH = 8;

export type ReviewCandidate = {
  creatorId: number; handle: string; platform: string; displayName: string | null; bio: string | null; followers: number | null;
  country: string | null; businessCategory: string | null; isBusiness: boolean | null; captions: string[];
};

// Обережно: «shopwithjess» чи «anna_official» — цілком можуть бути авторами; такі межові випадки вирішує модель.
const AGENCY_NAME = /(agency|mgmt|management|wholesale|marketing|talents?(?!ed))/i;
const AGENCY_BIO = /\b(talent agency|management agency|influencer agency|we represent|our (creators|talents|influencers)|book (our|a) creator|shop now|free shipping|order now|wholesale|dm to order|link to shop|use code \w+ for \d+% off our)\b/i;
const BRAND_CATEGORY = /(shopping|retail|brand|product\/service|clothing store|e-?commerce|agency|marketing|advertising)/i;

/** Явні невідповідності, які видно без моделі. */
export function codeVerdict(c: ReviewCandidate, spec: OrderSpec): Pick<ReviewItem, "verdict" | "reason" | "reasonUk"> | null {
  const name = `${c.handle} ${c.displayName ?? ""}`;
  if (AGENCY_NAME.test(name) || AGENCY_BIO.test(c.bio ?? "") || (c.isBusiness && BRAND_CATEGORY.test(c.businessCategory ?? ""))) {
    return { verdict: "no", reason: "brand, shop or agency account", reasonUk: "акаунт бренду, магазину чи агентства, а не автор" };
  }
  // 10% запасу: 4 600 при мінімумі 5 000 клієнт не помітить, а 3 000 — помітить.
  if (c.followers != null && spec.followersMin != null && c.followers < spec.followersMin * 0.9) {
    return { verdict: "no", reason: "too few followers", reasonUk: `замало підписників (${c.followers.toLocaleString("uk-UA")})` };
  }
  if (c.followers != null && spec.followersMax != null && c.followers > spec.followersMax * 1.1) {
    return { verdict: "no", reason: "too many followers", reasonUk: `забагато підписників (${c.followers.toLocaleString("uk-UA")})` };
  }
  if (c.country && Array.isArray(spec.countries) && spec.countries.length && !spec.countries.includes(c.country)) {
    return { verdict: "no", reason: "outside the requested countries", reasonUk: `країна ${c.country}, а клієнту потрібні ${spec.countries.join(", ")}` };
  }
  return null;
}

const ReviewSchema = z.object({
  creators: z.array(z.object({
    handle: z.string().catch(""),
    verdict: z.enum(["fits", "no", "unsure"]).catch("unsure"),
    reason_en: z.string().catch(""),
    reason_uk: z.string().catch(""),
    quote: z.string().nullable().catch(null),
  })).catch([]),
});
export type ReviewRaw = z.infer<typeof ReviewSchema>["creators"];

const REVIEW_SYSTEM = `You check creators for a client before a freelancer sends the list. ${GUARD}
For each creator decide against TASK:
- "fits": their bio or captions clearly show they make content in the client's niche (or close to it) and they are an individual creator.
- "no": clearly wrong: a brand, shop, agency, coach selling courses, a different niche, or breaks a TASK.exclude rule.
- "unsure": not enough information to tell.
reason_en: max 12 plain words for the client, e.g. "posts dog care reels with her two corgis". reason_uk: the same in Ukrainian.
quote: words copied exactly from that creator's bio or captions that support the verdict (null for unsure).
Return ONLY JSON: {"creators": [{"handle": "...", "verdict": "fits|no|unsure", "reason_en": "...", "reason_uk": "...", "quote": "..."}]}`;

const corpus = (c: ReviewCandidate) => [c.displayName ?? "", c.bio ?? "", ...c.captions].join("\n");

/** Вердикт моделі лише з цитатою з даних самого автора; інакше — «сумнівно». */
export function groundReview(raw: ReviewRaw, batch: ReviewCandidate[]): ReviewItem[] {
  return batch.map((c) => {
    const r = raw.find((x) => x.handle.replace(/^@/, "").toLowerCase() === c.handle.toLowerCase());
    const base = { creatorId: c.creatorId, handle: c.handle, platform: c.platform, by: "ai" as const };
    if (!r || r.verdict === "unsure" || !r.quote || !quoteFound(r.quote, corpus(c))) {
      return { ...base, verdict: "unsure" as const, reason: "", reasonUk: r?.reason_uk?.trim() || "модель не знайшла доказів у біо чи дописах", quote: null };
    }
    return { ...base, verdict: r.verdict, reason: r.reason_en.trim().slice(0, 120), reasonUk: r.reason_uk.trim().slice(0, 160), quote: r.quote.trim().slice(0, 200) };
  });
}

/** Кандидати замовлення за рейтингом пошуку, кожен автор один раз. */
export async function orderCandidates(db: Db, searchIds: number[]): Promise<ReviewCandidate[]> {
  if (!searchIds.length) return [];
  const rows = await db.select({ cand: searchCandidates, c: creators }).from(searchCandidates)
    .innerJoin(creators, eq(creators.id, searchCandidates.creatorId))
    .where(and(inArray(searchCandidates.searchId, searchIds), eq(searchCandidates.stage, "qualified")))
    .orderBy(desc(searchCandidates.lead), desc(searchCandidates.score)).limit(500);
  const seen = new Set<number>();
  const uniq = rows.filter(({ c }) => !seen.has(c.id) && seen.add(c.id));
  const postIds = uniq.flatMap(({ cand }) => cand.postIds.slice(0, 3));
  const posts = postIds.length ? await db.select({ id: contentItems.id, data: contentItems.data }).from(contentItems).where(inArray(contentItems.id, postIds)) : [];
  return uniq.map(({ cand, c }) => ({
    creatorId: c.id, handle: c.username, platform: c.platform, displayName: c.displayName, bio: c.bio, followers: c.followers, country: c.country,
    businessCategory: c.businessCategory, isBusiness: c.isBusiness,
    captions: cand.postIds.slice(0, 3).map((id) => posts.find((p) => p.id === id)?.data.text ?? "").filter(Boolean).map((t) => t.slice(0, 300)),
  }));
}

const fitsCount = (review: ReviewItem[]) => review.filter((r) => r.verdict === "fits").length;

/**
 * Один крок перевірки (до REVIEW_BATCH авторів через модель). Повертає, чи перевірка завершена:
 * підходящих уже стільки, скільки просив клієнт, або перевірено всіх кандидатів.
 */
export async function reviewStep(db: Db, o: Order): Promise<{ done: boolean; review: ReviewItem[] }> {
  if (!o.spec) return { done: true, review: o.review };
  const need = o.spec.count ?? 20;
  const review = [...o.review];
  const reviewed = new Set(review.map((r) => r.creatorId));
  const pending = (await orderCandidates(db, o.searchIds)).filter((c) => !reviewed.has(c.creatorId));
  const batch: ReviewCandidate[] = [];
  let consumed = 0;
  for (const c of pending) {
    if (fitsCount(review) >= need || batch.length >= REVIEW_BATCH) break;
    consumed++;
    const v = codeVerdict(c, o.spec);
    if (v) review.push({ creatorId: c.creatorId, handle: c.handle, platform: c.platform, ...v, quote: null, by: "code" });
    else batch.push(c);
  }
  if (batch.length) {
    const task = { niche: o.spec.niche, brand: o.spec.brand, must_have: o.spec.mustHave, exclude: o.spec.exclude, focus: o.spec.focus };
    const res = await chatJsonMeta(db, ReviewSchema, [
      { role: "system", content: REVIEW_SYSTEM },
      { role: "user", content: `TASK (from the client, trusted):\n${JSON.stringify(task)}\n\n${dataBlock("creators", JSON.stringify(batch.map((c) => ({
        handle: c.handle, name: c.displayName, bio: c.bio?.slice(0, 400), captions: c.captions,
      })), null, 1))}` },
    ], { purpose: "order-review", maxTokens: 900 });
    review.push(...groundReview(res.data.creators, batch));
  }
  await db.update(orders).set({ review, updatedAt: new Date() }).where(eq(orders.id, o.id));
  return { done: fitsCount(review) >= need || consumed >= pending.length, review };
}

/** Ваше рішення щодо «сумнівного» автора (чи зміна будь-якого вердикту). */
export async function setReviewVerdict(db: Db, orderId: number, creatorId: number, verdict: "fits" | "no"): Promise<void> {
  const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!o) return;
  const review = o.review.map((r) => r.creatorId === creatorId ? { ...r, verdict, by: "you" as const, reason: r.reason || (verdict === "fits" ? "approved by hand" : "") } : r);
  await db.update(orders).set({ review, updatedAt: new Date() }).where(eq(orders.id, orderId));
}

/** Файл для клієнта: лише перевірені «підходить», зрозумілі колонки англійською, без внутрішніх оцінок. */
export async function clientCsv(db: Db, o: Order): Promise<{ csv: string; rows: number }> {
  const fits = o.review.filter((r) => r.verdict === "fits");
  if (!fits.length) return { csv: toCsv(["creator"], []), rows: 0 };
  const cs = await db.select().from(creators).where(inArray(creators.id, fits.map((f) => f.creatorId)));
  const head = ["creator", "platform", "profile_url", "followers", "engagement_rate_pct", "country", "email", "why_it_fits"];
  const rows = fits.map((f) => {
    const c = cs.find((x) => x.id === f.creatorId);
    return [
      f.handle, f.platform === "tiktok" ? "TikTok" : "Instagram", profileUrl(f.platform, f.handle), c?.followers ?? "",
      c?.erLikes != null ? Math.round(c.erLikes * 1000) / 10 : "", c?.country ?? "", c?.emails[0] ?? "", f.reason,
    ];
  });
  return { csv: toCsv(head, rows), rows: rows.length };
}
