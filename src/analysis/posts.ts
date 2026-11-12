/**
 * Факти про дописи з сирих відповідей Apify: те, що не входить у загальний контракт (відмітки,
 * співавтори, позначка «Платне партнерство», останні коментарі), але потрібне для аналізу автора.
 * Усі цифри тут рахує код — мовна модель отримує їх готовими й нічого не підраховує сама.
 */

export type CommentFacts = { text: string; owner?: string; likes?: number; postUrl?: string; at?: string };

export type PostFacts = {
  url: string;
  shortCode: string;
  caption: string;
  hashtags: string[];
  likes: number | null;
  comments: number | null;
  views: number | null;
  publishedAt: Date | null;
  pinned: boolean;
  isVideo: boolean;
  videoUrl?: string;
  audioUrl?: string;
  cover?: string;
  mentions: string[];
  coauthors: string[];
  tagged: string[];
  /** Позначка «Платне партнерство» від Instagram; null — поле не прийшло. */
  paid: boolean | null;
  location?: string;
  owner?: string;
  latestComments: CommentFacts[];
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const httpUrl = (v: unknown) => (typeof v === "string" && /^https?:\/\//.test(v) ? v : undefined);
/** Відмітки й співавтори приходять то рядками, то об’єктами з username. */
const handles = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [])
    .map((x) => (typeof x === "string" ? x : (x as { username?: unknown })?.username))
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .map((x) => x.replace(/^@/, "").toLowerCase());

export function commentFromRaw(c: any, postUrl?: string): CommentFacts | null {
  const text = str(c?.text).trim();
  if (!text) return null;
  return {
    text: text.slice(0, 500),
    owner: str(c?.ownerUsername || c?.owner?.username).toLowerCase() || undefined,
    likes: num(c?.likesCount) ?? undefined,
    postUrl: httpUrl(c?.postUrl) ?? postUrl,
    at: str(c?.timestamp) || undefined,
  };
}

export function postFactsFromRaw(raw: any): PostFacts | null {
  const url = httpUrl(raw?.url);
  if (!raw?.shortCode || !url) return null;
  const isVideo = raw.type === "Video" || !!httpUrl(raw.videoUrl);
  const ts = raw.timestamp && !Number.isNaN(Date.parse(raw.timestamp)) ? new Date(raw.timestamp) : null;
  return {
    url,
    shortCode: String(raw.shortCode),
    caption: str(raw.caption),
    hashtags: (Array.isArray(raw.hashtags) ? raw.hashtags : []).filter((t: unknown): t is string => typeof t === "string").map((t: string) => t.toLowerCase()),
    likes: num(raw.likesCount),
    comments: num(raw.commentsCount),
    views: num(raw.videoPlayCount) ?? num(raw.videoViewCount),
    publishedAt: ts,
    pinned: raw.isPinned === true,
    isVideo,
    videoUrl: httpUrl(raw.videoUrl),
    audioUrl: httpUrl(raw.audioUrl),
    cover: httpUrl(raw.displayUrl),
    mentions: handles(raw.mentions),
    coauthors: handles(raw.coauthorProducers),
    tagged: handles(raw.taggedUsers),
    paid: typeof raw.paidPartnership === "boolean" ? raw.paidPartnership : typeof raw.isSponsored === "boolean" ? raw.isSponsored : null,
    location: str(raw.locationName) || undefined,
    owner: str(raw.ownerUsername).toLowerCase() || undefined,
    latestComments: (Array.isArray(raw.latestComments) ? raw.latestComments : [])
      .map((c: any) => commentFromRaw(c, url))
      .filter((c: CommentFacts | null): c is CommentFacts => c != null),
  };
}

/** Власні дописи автора з сирого профілю (спільні дописи інших акаунтів не беремо). */
export function profilePosts(rawProfile: any): PostFacts[] {
  const username = str(rawProfile?.username).toLowerCase();
  return (Array.isArray(rawProfile?.latestPosts) ? rawProfile.latestPosts : [])
    .map((p: any) => postFactsFromRaw({ ...p, ownerUsername: p?.ownerUsername ?? username }))
    .filter((p: PostFacts | null): p is PostFacts => p != null && (!p.owner || p.owner === username || p.coauthors.includes(username)));
}

/** Об’єднує дописи з профілю й з хештегів: у дописах із хештегів бувають поля, яких немає в профілі. */
export function mergePosts(a: PostFacts[], b: PostFacts[]): PostFacts[] {
  const by = new Map<string, PostFacts>();
  for (const p of [...a, ...b]) {
    const prev = by.get(p.shortCode);
    if (!prev) {
      by.set(p.shortCode, p);
      continue;
    }
    by.set(p.shortCode, {
      ...prev,
      likes: prev.likes ?? p.likes, comments: prev.comments ?? p.comments, views: prev.views ?? p.views,
      paid: prev.paid ?? p.paid, tagged: [...new Set([...prev.tagged, ...p.tagged])],
      latestComments: prev.latestComments.length ? prev.latestComments : p.latestComments,
      videoUrl: prev.videoUrl ?? p.videoUrl, audioUrl: prev.audioUrl ?? p.audioUrl,
    });
  }
  return [...by.values()].sort((x, y) => (y.publishedAt?.getTime() ?? 0) - (x.publishedAt?.getTime() ?? 0));
}

export const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

export type PostMetrics = {
  posts: number;
  withLikes: number;
  medianLikes: number | null;
  medianComments: number | null;
  medianViews: number | null;
  /** Коментарів на одне вподобання (медіани). */
  commentsPerLike: number | null;
  /** Коефіцієнт варіації вподобань: майже однакові числа на всіх дописах — ознака купівлі. */
  likesCv: number | null;
  postsPerWeek: number | null;
  /** Автор приховав лічильники вподобань на більшості дописів. */
  hiddenLikes: boolean;
  erLikes: number | null;
  erComments: number | null;
};

const round = (n: number | null, digits = 4) => (n == null ? null : Math.round(n * 10 ** digits) / 10 ** digits);

/** Підсумок дописів. Закріплені не рахуємо: це старі «найкращі» дописи, вони завищують середнє. */
export function postMetrics(posts: PostFacts[], followers: number | null | undefined): PostMetrics {
  const recent = posts.filter((p) => !p.pinned).slice(0, 12);
  const likes = recent.map((p) => p.likes).filter((n): n is number => n != null);
  const comments = recent.map((p) => p.comments).filter((n): n is number => n != null);
  const views = recent.filter((p) => p.isVideo).map((p) => p.views).filter((n): n is number => n != null);
  const ml = median(likes);
  const mc = median(comments);
  let cv: number | null = null;
  if (likes.length >= 4) {
    const mean = likes.reduce((a, b) => a + b, 0) / likes.length;
    const sd = Math.sqrt(likes.reduce((a, b) => a + (b - mean) ** 2, 0) / likes.length);
    cv = mean > 0 ? sd / mean : null;
  }
  const dates = recent.map((p) => p.publishedAt?.getTime()).filter((t): t is number => t != null).sort((a, b) => a - b);
  const spanWeeks = dates.length >= 2 ? (dates[dates.length - 1] - dates[0]) / (7 * 86_400_000) : 0;
  return {
    posts: recent.length,
    withLikes: likes.length,
    medianLikes: ml,
    medianComments: mc,
    medianViews: median(views),
    commentsPerLike: ml && mc != null ? round(mc / ml) : null,
    likesCv: round(cv, 3),
    postsPerWeek: spanWeeks >= 1 ? round((dates.length - 1) / spanWeeks, 1) : null,
    hiddenLikes: recent.length >= 3 && likes.length < recent.length / 2,
    erLikes: ml != null && followers ? round(ml / followers) : null,
    erComments: mc != null && followers ? round(mc / followers) : null,
  };
}
