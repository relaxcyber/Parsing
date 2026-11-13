import { and, eq, inArray } from "drizzle-orm";
import { detectAd } from "@/analysis/ads";
import type { PostFacts } from "@/analysis/posts";
import type { Db } from "@/db/client";
import { brandAccounts, brandCollabs, creators, type BrandCollab, type BrandCollabRow } from "@/db/schema";

/**
 * Докази співпраці брендів з авторами і цифри з них. Записуються з кожного пошуку авторів безкоштовно
 * (дописи вже зібрані) і з пошуків брендів. Усі цифри рахує код з дописів; того, чого з публічних даних
 * не видно (скільки бренд платить, бюджет реклами), тут немає.
 */

const HANDLE = /^[a-z0-9._]{2,30}$/;
/** Платформи й сервіси, які відмічають у дописах, але писати їм як бренду безглуздо. */
const NOT_BRANDS = new Set([
  "instagram", "creators", "tiktok", "youtube", "facebook", "meta", "threads", "reels", "explore", "linktree", "amazon", "amazonfashion",
  "amazoninfluencer", "ltk.it", "shopltk", "liketoknow.it", "shopmy", "ugc", "ugccreator", "ugccreators", "canva", "capcut", "later", "collabstr",
]);
/** Агентства й площадки співпраць: їхні спільні дописи з авторами — не реклама бренду. */
export const AGENCY = /(agency|agencia|agence|mgmt|management|talents?(?!ed)|publicidad|marketing|influencers?(?=[._]|$)|collabs?(?=[._]|$)|\bpr\b|ugcagency|creatorhub)/i;
/** Категорії профілю, за якими це людина, а не бренд. */
export const PERSON_CATEGORY = /(creator|blogger|\bblog\b|public figure|artist|photographer|videographer|musician|band|athlete|influencer|model|gamer|comedian|writer|author|personal|actor|actress|dancer|journalist|coach|trainer|chef|host|editor|stylist)/i;
/** Імена на кшталт «sora.rojasugc» чи «ugc_bylily» — автори, а не бренди. */
const CREATOR_HANDLE = /ugc|creates|creator|influenc/i;

export type CreatorPosts = { creator: string; followers: number | null; posts: PostFacts[] };

/** Бренди з рекламних дописів: бренд → докази (кожен допис один раз). Відмітки інших авторів вибірки — не бренди. */
export function collectCollabs(list: CreatorPosts[], skip: Set<string> = new Set()): { collabs: Map<string, BrandCollab[]>; adPosts: number } {
  const collabs = new Map<string, BrandCollab[]>();
  let adPosts = 0;
  for (const c of list) {
    if (AGENCY.test(c.creator)) continue;
    for (const p of c.posts) {
      const ad = detectAd(p, c.creator);
      if (!ad) continue;
      adPosts++;
      for (const raw of ad.brands) {
        const b = raw.toLowerCase().replace(/^@/, "").replace(/[.]+$/, "");
        if (!HANDLE.test(b) || b === c.creator || skip.has(b) || NOT_BRANDS.has(b) || CREATOR_HANDLE.test(b)) continue;
        const items = collabs.get(b) ?? [];
        if (!items.some((x) => x.postUrl === p.url)) {
          items.push({
            creator: c.creator, followers: c.followers, postUrl: p.url, reason: ad.reason, paid: p.paid === true, at: p.publishedAt?.toISOString() ?? null,
            likes: p.likes, comments: p.comments,
          });
        }
        collabs.set(b, items);
      }
    }
  }
  return { collabs, adPosts };
}

export const distinctCreators = (cs: Pick<BrandCollab, "creator">[]) => new Set(cs.map((c) => c.creator)).size;

/** Спершу бренди, з якими працювало більше різних авторів і з позначкою «Платне партнерство». */
export function rankCollabs(collabs: Map<string, BrandCollab[]>): [string, BrandCollab[]][] {
  const score = (cs: BrandCollab[]) => distinctCreators(cs) * 3 + cs.filter((c) => c.paid).length * 2 + cs.length;
  return [...collabs.entries()].sort((a, b) => score(b[1]) - score(a[1]) || a[0].localeCompare(b[0]));
}

/** Записує докази в базу брендів. Відмітки відомих нам авторів (вони є серед креаторів) брендами не вважаємо. */
export async function saveCollabs(
  db: Db, collabs: Map<string, BrandCollab[]>, src: { searchId?: number; scoutId?: number; creatorIds?: Map<string, number> } = {}, platform = "instagram",
): Promise<number> {
  let handles = [...collabs.keys()];
  if (!handles.length) return 0;
  const known = await db.select({ u: creators.username, biz: creators.isBusiness, cat: creators.businessCategory }).from(creators)
    .where(and(eq(creators.platform, platform), inArray(creators.username, handles)));
  // Бізнес-акаунт з небізнесовою категорією — це магазин, який теж потрапив у пошук авторів: його лишаємо.
  const knownSet = new Set(known.filter((x) => !x.biz || PERSON_CATEGORY.test(x.cat ?? "")).map((x) => x.u));
  handles = handles.filter((h) => !knownSet.has(h));
  if (!handles.length) return 0;
  await db.insert(brandAccounts).values(handles.map((handle) => ({ platform, handle }))).onConflictDoNothing();
  const ids = await db.select({ id: brandAccounts.id, handle: brandAccounts.handle }).from(brandAccounts)
    .where(and(eq(brandAccounts.platform, platform), inArray(brandAccounts.handle, handles)));
  const rows = ids.flatMap(({ id, handle }) => (collabs.get(handle) ?? []).map((c) => ({
    brandId: id, creator: c.creator, creatorId: src.creatorIds?.get(c.creator) ?? null, creatorFollowers: c.followers, postUrl: c.postUrl,
    paid: c.paid, reason: c.reason.slice(0, 200), at: c.at ? new Date(c.at) : null, likes: c.likes ?? null, comments: c.comments ?? null,
    searchId: src.searchId ?? null, scoutId: src.scoutId ?? null,
  })));
  if (rows.length) await db.insert(brandCollabs).values(rows).onConflictDoNothing();
  return rows.length;
}

/** З пошуку авторів: реклама в дописах одного автора → база брендів. Безкоштовно, без запитів назовні. */
export async function recordCreatorAds(db: Db, c: { id: number; username: string; followers: number | null }, posts: PostFacts[], searchId: number): Promise<number> {
  const { collabs } = collectCollabs([{ creator: c.username, followers: c.followers, posts }]);
  return saveCollabs(db, collabs, { searchId, creatorIds: new Map([[c.username, c.id]]) });
}

/* ---------- Цифри бренду ---------- */

export type BrandMetrics = {
  /** Різних авторів з рекламою бренду (усього / за останні 90 днів). */
  creators: number;
  active90: number;
  posts: number;
  paidPosts: number;
  /** Автори, з якими бренд працював більше одного разу: ознака, що співпраця окупилась. */
  repeatCreators: number;
  lastAt: string | null;
  /** Розмір авторів, з якими працює бренд. */
  followers: { min: number; median: number; max: number } | null;
  /** Медіана вподобань рекламних дописів до підписників автора, %. */
  adEr: number | null;
  /** Приклади: найбільші автори з посиланням на рекламний допис. */
  examples: { creator: string; followers: number | null; postUrl: string }[];
  /** Опубліковані ставки за UGC у тих авторів, що з ним працювали (USD, з їхніх сторінок-візиток). */
  rates: { min: number; max: number; creators: number } | null;
};

const DAY = 86_400_000;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

type CollabLike = Pick<BrandCollabRow, "creator" | "creatorFollowers" | "paid" | "at" | "likes" | "postUrl">;

/** Докази зі збереженого пошуку брендів у формі рядків бази. */
export const asCollabRows = (cs: BrandCollab[]): CollabLike[] =>
  cs.map((c) => ({ creator: c.creator, creatorFollowers: c.followers, paid: c.paid, at: c.at ? new Date(c.at) : null, likes: c.likes ?? null, postUrl: c.postUrl }));

export function brandMetrics(cs: CollabLike[], rates: Map<string, number[]> = new Map(), now = new Date()): BrandMetrics {
  const byCreator = new Map<string, CollabLike[]>();
  for (const c of cs) byCreator.set(c.creator, [...(byCreator.get(c.creator) ?? []), c]);
  // Підписники автора — найсвіжіше відоме значення.
  const sizes = [...byCreator.values()].map((xs) => xs.map((x) => x.creatorFollowers).filter((n): n is number => n != null && n > 0).at(-1)).filter((n): n is number => n != null);
  const ers = cs.filter((c) => c.likes != null && c.likes >= 0 && c.creatorFollowers).map((c) => (c.likes! / c.creatorFollowers!) * 100);
  const dates = cs.map((c) => c.at).filter((d): d is Date => d != null);
  const recent = new Set(cs.filter((c) => c.at && now.getTime() - c.at.getTime() <= 90 * DAY).map((c) => c.creator));
  const priced = [...byCreator.keys()].map((k) => rates.get(k) ?? []).filter((r) => r.length);
  const allRates = priced.flat();
  return {
    creators: byCreator.size,
    active90: recent.size,
    posts: cs.length,
    paidPosts: cs.filter((c) => c.paid).length,
    repeatCreators: [...byCreator.values()].filter((xs) => xs.length >= 2).length,
    lastAt: dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))).toISOString() : null,
    followers: sizes.length ? { min: Math.min(...sizes), median: Math.round(median(sizes)), max: Math.max(...sizes) } : null,
    adEr: ers.length ? Math.round(median(ers) * 10) / 10 : null,
    examples: [...byCreator.entries()].map(([creator, xs]) => ({ creator, followers: xs.at(-1)!.creatorFollowers, postUrl: xs.at(-1)!.postUrl }))
      .sort((a, b) => (b.followers ?? 0) - (a.followers ?? 0)).slice(0, 3),
    rates: allRates.length ? { min: Math.min(...allRates), max: Math.max(...allRates), creators: priced.length } : null,
  };
}

/** Чи працює бренд з авторами такого розміру: від половини найменшого до подвоєного найбільшого. */
export const sizeFits = (m: BrandMetrics, followers: number) => !!m.followers && followers >= m.followers.min / 2 && followers <= m.followers.max * 2;

/** Цифри для набору брендів з усієї бази доказів. */
export async function metricsFor(db: Db, brandIds: number[], now = new Date()): Promise<Map<number, BrandMetrics>> {
  const out = new Map<number, BrandMetrics>();
  if (!brandIds.length) return out;
  const rows: BrandCollabRow[] = [];
  for (let i = 0; i < brandIds.length; i += 1000) rows.push(...await db.select().from(brandCollabs).where(inArray(brandCollabs.brandId, brandIds.slice(i, i + 1000))));
  const names = [...new Set(rows.map((r) => r.creator))];
  const rates = new Map<string, number[]>();
  for (let i = 0; i < names.length; i += 1000) {
    const cs = await db.select({ u: creators.username, rates: creators.rates }).from(creators).where(and(eq(creators.platform, "instagram"), inArray(creators.username, names.slice(i, i + 1000))));
    for (const c of cs) {
      const usd = c.rates.filter((r) => r.currency === "USD" && r.amount > 0).map((r) => r.amount);
      if (usd.length) rates.set(c.u, usd);
    }
  }
  const by = new Map<number, BrandCollabRow[]>();
  for (const r of rows) by.set(r.brandId, [...(by.get(r.brandId) ?? []), r]);
  for (const id of brandIds) out.set(id, brandMetrics(by.get(id) ?? [], rates, now));
  return out;
}

const k = (n: number) => (n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));
/** Коротко для таблиці й файлу: «5K–40K (медіана 12K)». */
export const sizeText = (m: BrandMetrics) => (m.followers ? `${k(m.followers.min)}–${k(m.followers.max)} (median ${k(m.followers.median)})` : "");
export const ratesText = (m: BrandMetrics) => (m.rates ? `$${m.rates.min}–$${m.rates.max} (${m.rates.creators} creators)` : "");
