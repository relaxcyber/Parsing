import { median, type PostFacts } from "./posts";

/**
 * Реклама в профілі: які дописи рекламні, з якими брендами автор працював, чи повертаються бренди,
 * і як аудиторія реагує на рекламу порівняно зі звичайними дописами. Усе рахує код за полями Instagram
 * і текстом підписів — без мовної моделі.
 */

const AD_TEXT =
  /(#(ad|ads|advert|sponsored|spon|partner|partnership|paidpartnership|gifted|collab|амбасадор|реклама|ambassador)\b|paid partnership|in partnership with|sponsored by|thanks to @|thank you @|(?:use (?:my )?code|promo ?code|discount code)(?::? ?[A-Z0-9]{4,}\b)?|affiliate link|commissions? earned|#commissionsearned|amazon\.com\/shop|amzn\.to|liketk\.it|shopmy\.us|рекламн|промокод|співпраця з|сотрудничеств)/i;

/** «code ANNA10» — лише з кодом великими літерами: інакше «dress code» теж стало б рекламою. */
const CODE = /\b[Cc]ode:? ?[A-Z][A-Z0-9]{3,}\b/;

export type AdPost = { url: string; reason: string; brands: string[]; likes: number | null };
export type AdsReport = {
  posts: number;
  adPosts: number;
  adShare: number;
  /** Медіана вподобань реклами / медіана звичайних дописів: 1 — реклама «заходить» не гірше. */
  adLikesRatio: number | null;
  brands: { name: string; count: number }[];
  repeatBrands: string[];
  competitors: string[];
  examples: AdPost[];
};

export function detectAd(p: PostFacts, creator: string): AdPost | null {
  const others = (xs: string[]) => xs.filter((x) => x && x !== creator);
  const brands = [...new Set([...others(p.coauthors), ...others(p.tagged), ...others(p.mentions)])];
  let reason: string | null = null;
  if (p.paid) reason = "позначка «Платне партнерство»";
  else if (others(p.coauthors).length) reason = `спільний допис з @${others(p.coauthors)[0]}`;
  else {
    const m = p.caption.match(AD_TEXT) ?? p.caption.match(CODE);
    if (m) reason = `у підписі: «${m[0].trim()}»`;
  }
  return reason ? { url: p.url, reason, brands, likes: p.likes } : null;
}

const clean = (h: string) => h.trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?instagram\.com\//, "").replace(/\/.*$/, "").toLowerCase();

export function analyzeAds(posts: PostFacts[], creator: string, competitors: string[] = []): AdsReport {
  const own = posts.filter((p) => !p.pinned).slice(0, 12);
  const ads = own.map((p) => detectAd(p, creator)).filter((a): a is AdPost => a != null);
  const adUrls = new Set(ads.map((a) => a.url));
  const counts = new Map<string, number>();
  for (const a of ads) for (const b of a.brands) counts.set(b, (counts.get(b) ?? 0) + 1);
  const brands = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })).slice(0, 15);

  const adLikes = median(ads.map((a) => a.likes).filter((n): n is number => n != null));
  const organicLikes = median(own.filter((p) => !adUrls.has(p.url)).map((p) => p.likes).filter((n): n is number => n != null));
  const comp = new Set(competitors.map(clean).filter(Boolean));
  const mentionedAnywhere = new Set(own.flatMap((p) => [...p.mentions, ...p.tagged, ...p.coauthors]));
  return {
    posts: own.length,
    adPosts: ads.length,
    adShare: own.length ? Math.round((ads.length / own.length) * 100) / 100 : 0,
    adLikesRatio: adLikes != null && organicLikes ? Math.round((adLikes / organicLikes) * 100) / 100 : null,
    brands,
    repeatBrands: brands.filter((b) => b.count >= 2).map((b) => b.name),
    competitors: [...comp].filter((c) => mentionedAnywhere.has(c)),
    examples: ads.slice(0, 5),
  };
}

/** Короткі висновки для списку «чому». */
export function adsReasons(r: AdsReport): string[] {
  const out: string[] = [];
  if (r.adPosts === 0) return r.posts >= 6 ? ["реклами в останніх дописах не видно"] : [];
  out.push(`реклама: ${r.adPosts} з ${r.posts} дописів`);
  if (r.repeatBrands.length) out.push(`повторні замовлення: ${r.repeatBrands.slice(0, 3).map((b) => `@${b}`).join(", ")}`);
  if (r.competitors.length) out.push(`працював з конкурентами: ${r.competitors.map((b) => `@${b}`).join(", ")}`);
  if (r.adLikesRatio != null) {
    if (r.adLikesRatio < 0.5) out.push(`мінус: реклама збирає вдвічі менше вподобань, ніж звичайні дописи`);
    else if (r.adLikesRatio >= 0.9) out.push("реклама збирає стільки ж вподобань, скільки звичайні дописи");
  }
  if (r.adShare > 0.6) out.push("мінус: більшість дописів — реклама");
  return out;
}
