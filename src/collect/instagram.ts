import type { ContentItemInput } from "@/core/contract";
import type { Db } from "@/db/client";
import { syncKeyQuota } from "@/keys/quota-sync";
import { ProviderHttpError, withKey } from "@/keys/router";
import { getJson, postJson } from "./http";

const PROFILE_ACTOR = "apify~instagram-profile-scraper";
const HASHTAG_ACTOR = "apify~instagram-hashtag-scraper";

const n = (v: unknown) => (typeof v === "number" && v >= 0 ? v : undefined);
const url = (v: unknown) => (typeof v === "string" && /^https?:\/\//.test(v) ? v : undefined);
const profileUrl = (username: string) => `https://www.instagram.com/${username}/`;

export function mapPost(raw: any, now = new Date()): ContentItemInput | null {
  const username: string | undefined = raw?.ownerUsername;
  const postUrl = url(raw?.url);
  if (!raw?.shortCode || !postUrl) return null;
  const cover = url(raw.displayUrl);
  const isVideo = raw.type === "Video";
  const images: string[] = (Array.isArray(raw.images) ? raw.images : []).map(url).filter(Boolean);
  const dims = { width: n(raw.dimensionsWidth) || undefined, height: n(raw.dimensionsHeight) || undefined };
  const media: ContentItemInput["media"] = isVideo
    ? url(raw.videoUrl)
      ? [{ type: "video", url: raw.videoUrl, thumbnailUrl: cover, ...dims, durationSec: n(raw.videoDuration) }]
      : cover ? [{ type: "image", url: cover, ...dims }] : []
    : images.length
      ? images.map((u) => ({ type: "image" as const, url: u }))
      : cover ? [{ type: "image", url: cover, ...dims }] : [];
  return {
    id: String(raw.shortCode), source: "instagram", kind: isVideo ? "video" : "post", url: postUrl,
    author: username
      ? { id: raw.ownerId ? String(raw.ownerId) : undefined, username, displayName: raw.ownerFullName || undefined, url: profileUrl(username) }
      : null,
    text: typeof raw.caption === "string" ? raw.caption : undefined,
    tags: Array.isArray(raw.hashtags) ? raw.hashtags.filter((t: unknown) => typeof t === "string") : [],
    media,
    // Instagram віддає -1, коли автор приховав лічильник.
    metrics: { likes: n(raw.likesCount), comments: n(raw.commentsCount), views: n(raw.videoPlayCount) ?? n(raw.videoViewCount) },
    publishedAt: raw.timestamp && !Number.isNaN(Date.parse(raw.timestamp)) ? new Date(raw.timestamp) : undefined,
    fetchedAt: now, via: "apify",
  };
}

/** Профіль + його останні пости як окремі елементи. */
export function mapProfile(raw: any, now = new Date()): ContentItemInput[] {
  const username: string | undefined = raw?.username;
  if (!username) return [];
  const links = [raw.externalUrl, ...(Array.isArray(raw.externalUrls) ? raw.externalUrls.map((l: any) => l?.url) : [])]
    .map(url)
    .filter((l, i, a): l is string => !!l && a.indexOf(l) === i);
  const author = {
    id: raw.id ? String(raw.id) : undefined, username, displayName: raw.fullName || undefined, url: profileUrl(username),
    avatarUrl: url(raw.profilePicUrlHD) ?? url(raw.profilePicUrl), bio: raw.biography || undefined,
    followers: n(raw.followersCount), links, verified: typeof raw.verified === "boolean" ? raw.verified : undefined,
  };
  const profile: ContentItemInput = {
    id: `profile:${username}`, source: "instagram", kind: "profile", url: author.url, author,
    title: author.displayName, text: author.bio, fetchedAt: now, via: "apify",
  };
  const posts = (Array.isArray(raw.latestPosts) ? raw.latestPosts : [])
    .map((p: any) => mapPost({ ...p, ownerUsername: p.ownerUsername ?? username, ownerFullName: raw.fullName }, now))
    .filter((p: ContentItemInput | null): p is ContentItemInput => p != null);
  return [profile, ...posts];
}

/**
 * Вартість запуску в $. Одразу після завершення usageTotalUsd ще буває нульовим, тому беремо
 * найбільше з трьох: підсумок Apify, «події × ціна» з тарифу актора, «результати × ціна основної події».
 */
export function runCostUsd(run: any, itemCount: number): number {
  const events: Record<string, any> = run?.pricingInfo?.pricingPerEvent?.actorChargeEvents ?? {};
  const price = (name: string) => (typeof events[name]?.eventPriceUsd === "number" ? events[name].eventPriceUsd : 0);
  const charged = Object.entries(run?.chargedEventCounts ?? {}).reduce((sum, [name, n]) => sum + price(name) * (Number(n) || 0), 0);
  const primary = Object.keys(events).find((name) => events[name]?.isPrimaryEvent);
  const estimated = primary ? price(primary) * itemCount : 0;
  const total = typeof run?.usageTotalUsd === "number" ? run.usageTotalUsd : 0;
  return Math.round(Math.max(total, charged, estimated) * 1e6) / 1e6;
}

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);
const API = "https://api.apify.com/v2";

/**
 * Запускає актор асинхронно й чекає завершення опитуванням: обрив з’єднання не губить запуск,
 * а фактична вартість ($) береться із самого запуску й одразу потрапляє в облік квоти.
 */
async function runActor(db: Db, actor: string, input: unknown, purpose: string): Promise<any[]> {
  let keyId = 0;
  const items = await withKey(
    db,
    "apify",
    async (key, usage) => {
      keyId = key.id;
      usage.units = 0;
      const started = (await postJson(`${API}/acts/${actor}/runs`, key.secret, input, 60_000))?.data;
      if (!started?.id) throw new Error("Apify: запуск не створено");
      let run = started;
      const deadline = Date.now() + 15 * 60_000;
      while (!TERMINAL.has(run.status)) {
        if (Date.now() > deadline) throw new Error(`Apify: запуск ${run.id} триває понад 15 хв — перевірте його в консолі Apify`);
        try {
          run = (await getJson(`${API}/actor-runs/${started.id}?waitForFinish=30`, key.secret, 60_000))?.data ?? run;
        } catch (e) {
          // Збій опитування не скасовує сам запуск — пробуємо ще, поки не вийде час.
          if (e instanceof ProviderHttpError && [401, 403, 404].includes(e.status)) throw e;
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
      usage.units = runCostUsd(run, 0);
      if (run.status !== "SUCCEEDED") throw new Error(`Apify: запуск завершився зі станом ${run.status}`);
      const res = await getJson(`${API}/datasets/${run.defaultDatasetId}/items?clean=true&format=json`, key.secret, 120_000);
      if (!Array.isArray(res)) throw new Error("Apify: неочікувана відповідь");
      usage.units = runCostUsd(run, res.length);
      return res;
    },
    { purpose },
  );
  // Звірка — уточнення; основний облік уже зроблено вартістю запуску. Помилку звірки
  // syncKeyQuota сам записує в lastError ключа.
  await syncKeyQuota(db, keyId).catch(() => {});
  return items;
}

export const cleanHandle = (v: string) => v.trim().replace(/^[@#]/, "").replace(/\/+$/, "");

export type Collected = { item: ContentItemInput; raw?: unknown };
export type Batch = { collected: Collected[]; skipped: string[] };

/** Перетворює відповідь актора; якщо жоден елемент не розпізнано — це зміна формату, а не «нічого не знайдено». */
function mapBatch(raw: any[], map: (r: any) => ContentItemInput[], what: string): Batch {
  const collected: Collected[] = [];
  const skipped: string[] = [];
  let notFound = 0;
  for (const r of raw) {
    // Актори повертають { error: ... } замість елемента, коли профіль/тег не знайдено.
    if (!r || r.error) {
      notFound++;
      if (r?.error) skipped.push(`Apify: ${String(r.errorDescription ?? r.error).slice(0, 120)}`);
      continue;
    }
    const mapped = map(r);
    if (mapped.length === 0) skipped.push(`нерозпізнаний елемент (поля: ${Object.keys(r).slice(0, 8).join(", ")})`);
    // Сирий запис зберігаємо лише з першим елементом (для профілю — із самим профілем).
    mapped.forEach((item, i) => collected.push(i === 0 ? { item, raw: r } : { item }));
  }
  if (raw.length > notFound && collected.length === 0) {
    throw new Error(
      `Apify повернув ${raw.length} елементів (${what}), але жоден не розпізнано — схоже, актор змінив формат. ` +
        `Зразок: ${JSON.stringify(raw.find((r) => r && !r.error)).slice(0, 600)}`,
    );
  }
  return { collected, skipped };
}

export async function fetchInstagramProfiles(db: Db, usernames: string[]): Promise<Batch> {
  const raw = await runActor(db, PROFILE_ACTOR, { usernames: usernames.map(cleanHandle) }, "instagram-profile");
  return mapBatch(raw, (r) => mapProfile(r), "профілі");
}

export async function fetchInstagramHashtag(db: Db, tag: string, limit: number): Promise<Batch> {
  const raw = await runActor(db, HASHTAG_ACTOR, { hashtags: [cleanHandle(tag)], resultsLimit: limit }, "instagram-hashtag");
  return mapBatch(raw, (r) => [mapPost(r)].filter((p): p is ContentItemInput => p != null), "дописи");
}
