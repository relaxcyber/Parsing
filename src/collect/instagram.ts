import type { ContentItemInput } from "@/core/contract";
import type { Db } from "@/db/client";
import { syncKeyQuota } from "@/keys/quota-sync";
import { ProviderHttpError, reportResult, withKey } from "@/keys/router";
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

const PRICE_GUESS_USD = 0.003; // трохи вище за поточні $0.0026 за результат
const POLL_DEADLINE_MS = 15 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type RunOptions = {
  /** Скільки результатів очікуємо — обмежує і набір даних, і списання. */
  maxItems: number;
  /** Викликається одразу після старту: id запуску треба зберегти, щоб не втратити оплачене. */
  onStart?: (runId: string) => Promise<void> | void;
};

/** Після старту запуск уже оплачується: повторюємо лише читання, ніколи не сам запуск. */
async function retryRead<T>(read: () => Promise<T>, attempts: number): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await read();
    } catch (e) {
      const fatal = e instanceof ProviderHttpError && [401, 403, 404].includes(e.status);
      if (fatal || i >= attempts) throw e;
      await sleep(e instanceof ProviderHttpError && e.retryAfterSec ? Math.min(e.retryAfterSec, 30) * 1000 : 2000 * i);
    }
  }
}

/**
 * Запускає актор і забирає результат.
 * Під withKey — лише сам старт: зміна ключа після старту означала б другий платний запуск.
 * Опитування та читання набору даних ідуть тим самим ключем із власними повторами, а вартість
 * записується в облік за будь-якого завершення — успіх, помилка чи вичерпаний час.
 */
async function runActor(db: Db, actor: string, input: unknown, purpose: string, opts: RunOptions): Promise<any[]> {
  // Стеля списання на рівні Apify: зайвого не зніме, навіть якщо актор поверне більше.
  const cap = Math.max(0.05, opts.maxItems * PRICE_GUESS_USD * 1.5).toFixed(2);
  const query = `maxItems=${opts.maxItems}&maxTotalChargeUsd=${cap}&timeout=${POLL_DEADLINE_MS / 1000 - 60}`;
  const { key, started } = await withKey(
    db,
    "apify",
    async (key, usage) => {
      usage.units = 0; // вартість запишемо після завершення
      const started = (await postJson(`${API}/acts/${actor}/runs?${query}`, key.secret, input, 60_000))?.data;
      if (!started?.id) throw new Error("Apify: запуск не створено");
      return { key, started };
    },
    { purpose: `${purpose}:start` },
  );
  await opts.onStart?.(started.id);

  let run = started;
  let items: any[] | undefined;
  let failure: Error | undefined;
  try {
    const deadline = Date.now() + POLL_DEADLINE_MS;
    while (!TERMINAL.has(run.status)) {
      if (Date.now() > deadline) throw new Error(`Apify: запуск ${run.id} триває понад 15 хв`);
      run = (await retryRead(() => getJson(`${API}/actor-runs/${started.id}?waitForFinish=30`, key.secret, 60_000), 5))?.data ?? run;
    }
    // Частковий результат (вичерпано час або стелю списання) теж оплачений — забираємо його.
    if (run.status === "FAILED" || run.status === "ABORTED") throw new Error(`Apify: запуск завершився зі станом ${run.status}`);
    const res = await retryRead(() => getJson(`${API}/datasets/${run.defaultDatasetId}/items?clean=true&format=json`, key.secret, 120_000), 4);
    if (!Array.isArray(res)) throw new Error("Apify: неочікувана відповідь");
    items = res;
  } catch (e) {
    failure = new Error(
      `${e instanceof Error ? e.message : e}. Запуск Apify ${started.id} міг бути оплачений — його результат зберігається в Apify 7 днів.`,
    );
  }
  await reportResult(db, key.id, {
    ok: !failure, units: runCostUsd(run, items?.length ?? 0), httpStatus: failure ? undefined : 200, error: failure?.message, purpose,
  }).catch((e) => console.error("Не вдалося записати вартість запуску Apify:", e));
  // Звірка — уточнення фактичного залишку; свою помилку вона сама пише в lastError ключа.
  await syncKeyQuota(db, key.id).catch(() => {});
  if (failure) throw failure;
  return items!;
}

/** «@name», «#tag» або посилання на профіль → чисте ім’я. */
export const cleanHandle = (v: string) => {
  const t = v.trim();
  const fromUrl = t.match(/^https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9._]+)\/?(?:\?.*)?$/)?.[1];
  return (fromUrl ?? t).replace(/^[@#]/, "").replace(/\/+$/, "");
};

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

type OnStart = Pick<RunOptions, "onStart">;

export async function fetchInstagramProfiles(db: Db, usernames: string[], opts: OnStart = {}): Promise<Batch> {
  const names = usernames.map(cleanHandle);
  const raw = await runActor(db, PROFILE_ACTOR, { usernames: names }, "instagram-profile", { maxItems: names.length, ...opts });
  return mapBatch(raw, (r) => mapProfile(r), "профілі");
}

export async function fetchInstagramHashtag(db: Db, tag: string, limit: number, opts: OnStart = {}): Promise<Batch> {
  const raw = await runActor(db, HASHTAG_ACTOR, { hashtags: [cleanHandle(tag)], resultsLimit: limit }, "instagram-hashtag", { maxItems: limit, ...opts });
  return mapBatch(raw, (r) => [mapPost(r)].filter((p): p is ContentItemInput => p != null), "дописи");
}
