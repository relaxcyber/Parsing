import type { ContentItemInput } from "@/core/contract";
import type { Batch, Collected } from "./instagram";

/**
 * TikTok без Apify, безкоштовно: публічна сторінка профілю tiktok.com/@ім’я віддає в HTML блок
 * __UNIVERSAL_DATA_FOR_REHYDRATION__ з профілем — підписники, вподобання, кількість роликів, біо,
 * посилання, ознаки бізнесу. Звичайний запит, як від браузера, по одному профілю з паузою.
 *
 * Чого так отримати не можна: список роликів, пошук за хештегами й словами — TikTok віддає їх лише
 * через підписані запити свого застосунку, і ми їх не обходимо. Тому авторів для TikTok знаходимо
 * інакше (ваш список, вебпошук site:tiktok.com, TikTok-посилання авторів з вашої бази Instagram),
 * а тут лише безкоштовно перевіряємо їхні профілі.
 */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
export const TIKTOK_HANDLE = /^[a-z0-9._]{2,24}$/;
export const tiktokUrl = (username: string) => `https://www.tiktok.com/@${username}`;

/** TikTok тимчасово не віддає профілі (обмеження частоти, перевірка): решту зберемо наступного разу. */
export class TikTokLimited extends Error {}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};
const httpUrl = (v: unknown) => {
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim();
  return /^https?:\/\//i.test(s) ? s : /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(s) ? `https://${s}` : null;
};

/** Сирий профіль у тій самій формі, що й профіль Instagram від Apify: решта конвеєра працює без змін. */
export type TikTokRaw = {
  platform: "tiktok"; username: string; id: string | null; fullName: string | null; biography: string | null;
  followersCount: number | null; followsCount: number | null; postsCount: number | null; likesTotal: number | null;
  externalUrl: string | null; verified: boolean | null; private: boolean | null; isBusinessAccount: boolean | null;
  businessCategoryName: string | null; profilePicUrl: string | null; language: string | null; region: string | null; latestPosts: [];
};

export type ParseResult = { raw: TikTokRaw } | { missing: string } | null;

/** Розбирає HTML сторінки профілю. null — сторінка без даних (обмеження чи зміна формату). */
export function parseTikTokProfile(html: string): ParseResult {
  const m = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  let data: any;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return null;
  }
  const detail = data?.__DEFAULT_SCOPE__?.["webapp.user-detail"];
  if (!detail) return null;
  if (detail.statusCode && detail.statusCode !== 0) {
    // 10202 — немає такого імені, 10221 — акаунт видалено чи заблоковано.
    if (detail.statusCode === 10202 || detail.statusCode === 10221) return { missing: "профіль не знайдено" };
    return { missing: `TikTok: ${detail.statusMsg || `код ${detail.statusCode}`}` };
  }
  const user = detail.userInfo?.user;
  if (!user?.uniqueId) return { missing: "TikTok: профіль не знайдено" };
  // statsV2 — рядки без переповнення (у stats лічильник вподобань великих акаунтів «перевертається» в мінус).
  const s2 = detail.userInfo?.statsV2 ?? {};
  const s = detail.userInfo?.stats ?? {};
  const commerce = user.commerceUserInfo ?? {};
  return {
    raw: {
      platform: "tiktok",
      username: String(user.uniqueId).toLowerCase(),
      id: user.id ? String(user.id) : null,
      fullName: user.nickname || null,
      biography: typeof user.signature === "string" && user.signature.trim() ? user.signature : null,
      followersCount: num(s2.followerCount) ?? num(s.followerCount),
      followsCount: num(s2.followingCount) ?? num(s.followingCount),
      postsCount: num(s2.videoCount) ?? num(s.videoCount),
      likesTotal: num(s2.heart) ?? num(s2.heartCount) ?? num(s.heart) ?? num(s.heartCount),
      externalUrl: httpUrl(user.bioLink?.link),
      verified: typeof user.verified === "boolean" ? user.verified : null,
      private: typeof user.privateAccount === "boolean" ? user.privateAccount : null,
      isBusinessAccount: commerce.commerceUser === true || user.ttSeller === true ? true : typeof commerce.commerceUser === "boolean" ? false : null,
      businessCategoryName: typeof commerce.category === "string" && commerce.category ? commerce.category : null,
      profilePicUrl: [user.avatarLarger, user.avatarMedium].find((x) => typeof x === "string" && /^https?:\/\//.test(x)) ?? null,
      language: typeof user.language === "string" ? user.language : null,
      region: typeof user.region === "string" && user.region ? user.region : null,
      latestPosts: [],
    },
  };
}

export function mapTikTokProfile(raw: TikTokRaw, now = new Date()): ContentItemInput {
  const url = tiktokUrl(raw.username);
  return {
    id: `profile:${raw.username}`, source: "tiktok", kind: "profile", url,
    author: {
      id: raw.id ?? undefined, username: raw.username, displayName: raw.fullName ?? undefined, url, avatarUrl: raw.profilePicUrl ?? undefined,
      bio: raw.biography ?? undefined, followers: raw.followersCount ?? undefined, links: raw.externalUrl ? [raw.externalUrl] : [],
      verified: raw.verified ?? undefined,
    },
    title: raw.fullName ?? undefined, text: raw.biography ?? undefined,
    metrics: { likes: raw.likesTotal ?? undefined },
    fetchedAt: now, via: "tiktok-page",
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type TikTokFetchOptions = { delayMs?: number; fetchImpl?: typeof fetch };

/**
 * Профілі по одному, з паузою між запитами. Якщо TikTok почав відмовляти (429/403 чи сторінки без
 * даних двічі поспіль) — зупиняємось: решта імен піде в «пропущені», їх можна зібрати пізніше.
 */
export async function fetchTikTokProfiles(usernames: string[], opts: TikTokFetchOptions = {}): Promise<Batch & { limited: boolean }> {
  const delay = opts.delayMs ?? Number(process.env.TIKTOK_DELAY_MS ?? 1500);
  const doFetch = opts.fetchImpl ?? fetch;
  const collected: Collected[] = [];
  const skipped: string[] = [];
  let blanks = 0;
  let limited = false;
  const names = [...new Set(usernames.map((u) => u.replace(/^@/, "").toLowerCase()))];
  for (const [i, name] of names.entries()) {
    if (limited) {
      skipped.push(`${name}: TikTok тимчасово обмежив запити`);
      continue;
    }
    if (!TIKTOK_HANDLE.test(name)) {
      skipped.push(`${name}: некоректне ім’я`);
      continue;
    }
    if (i > 0) await sleep(delay);
    let res: Response;
    try {
      res = await doFetch(tiktokUrl(name), {
        headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9", accept: "text/html,application/xhtml+xml" },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      skipped.push(`${name}: мережа: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    if (res.status === 404) {
      skipped.push(`${name}: профіль не знайдено`);
      continue;
    }
    if (res.status === 429 || res.status === 403) {
      limited = true;
      skipped.push(`${name}: TikTok відповів ${res.status}`);
      continue;
    }
    const parsed = parseTikTokProfile(await res.text());
    if (parsed == null) {
      skipped.push(`${name}: сторінка без даних профілю`);
      if (++blanks >= 2) limited = true;
      continue;
    }
    blanks = 0;
    if ("missing" in parsed) {
      skipped.push(`${name}: ${parsed.missing}`);
      continue;
    }
    collected.push({ item: mapTikTokProfile(parsed.raw), raw: parsed.raw });
  }
  return { collected, skipped, costUsd: 0, limited };
}

/** Імена TikTok у посиланнях (вебпошук, біо, сторінки-візитки). */
export function tiktokHandles(texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    for (const m of t.matchAll(/tiktok\.com\/@([A-Za-z0-9._]{2,24})/gi)) {
      const h = m[1].toLowerCase().replace(/\.+$/, "");
      if (TIKTOK_HANDLE.test(h)) out.add(h);
    }
  }
  return [...out];
}
