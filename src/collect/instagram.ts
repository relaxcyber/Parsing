import type { ContentItemInput } from "@/core/contract";
import type { Db } from "@/db/client";
import { syncKeyQuota } from "@/keys/quota-sync";
import { withKey } from "@/keys/router";
import { postJson } from "./http";

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

async function runActor(db: Db, actor: string, input: unknown, purpose: string): Promise<any[]> {
  let keyId = 0;
  const items = await withKey(
    db,
    "apify",
    async (key, usage) => {
      keyId = key.id;
      usage.units = 0; // реальну вартість у $ підтягуємо звіркою нижче
      const res = await postJson(`https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items`, key.secret, input, 300_000);
      if (!Array.isArray(res)) throw new Error("Apify: неочікувана відповідь");
      return res;
    },
    { purpose },
  );
  await syncKeyQuota(db, keyId).catch(() => {});
  // Актори повертають { error: ... } замість елемента, коли профіль/тег не знайдено.
  return items.filter((i) => i && !i.error);
}

export const cleanHandle = (v: string) => v.trim().replace(/^[@#]/, "").replace(/\/+$/, "");

export async function fetchInstagramProfiles(db: Db, usernames: string[]): Promise<ContentItemInput[]> {
  const raw = await runActor(db, PROFILE_ACTOR, { usernames: usernames.map(cleanHandle) }, "instagram-profile");
  return raw.flatMap((r) => mapProfile(r));
}

export async function fetchInstagramHashtag(db: Db, tag: string, limit: number): Promise<ContentItemInput[]> {
  const raw = await runActor(db, HASHTAG_ACTOR, { hashtags: [cleanHandle(tag)], resultsLimit: limit }, "instagram-hashtag");
  return raw.map((r) => mapPost(r)).filter((p): p is ContentItemInput => p != null);
}
