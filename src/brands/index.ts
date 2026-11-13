import { and, asc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { detectAd } from "@/analysis/ads";
import { mergePosts, postFactsFromRaw, profilePosts, type PostFacts } from "@/analysis/posts";
import { collect, collectProfiles } from "@/collect";
import { fetchLocalHtml, isChallenge } from "@/collect/local";
import type { Db } from "@/db/client";
import { brandScouts, contentItems, type BrandCollab, type BrandCreator, type BrandLead, type BrandScout, type BrandScoutStats, type BrandVerdict } from "@/db/schema";
import { checkEmail, usable } from "@/enrich/email";
import { detectLanguage } from "@/enrich/geo";
import { LINK_HUB } from "@/enrich/links";
import { chatJsonMeta, dataBlock, GUARD, LlmUnavailableError } from "@/llm/client";
import { HUMAN_RULES, humanize, looksLikePhone, styleBlock, tellIssues } from "@/llm/human";
import { numTokens } from "@/outreach/negotiate";
import { suggestFromBrief } from "@/search/brief";
import { toCsv } from "@/search/csv";
import { extractEmails } from "@/search/signals";
import { PRICE } from "@/search/sources";

/**
 * Бренди для креаторів: хто вже платить авторам у ніші.
 *  1. Дописи з хештегів ніші → автори → їхні останні дописи (один профіль = ~12 дописів за ціною одного).
 *  2. Код знаходить рекламні дописи (позначка партнерства, #ad, промокод, спільний допис) і бренди, відмічені в них.
 *  3. Профілі брендів: код відсіює авторів, друзів і фотографів (категорія профілю, сайт), шукає email у біо й на сайті.
 *  4. Лист від креатора бренду — лише з фактів, з перевіркою на вигадані цифри, посилання й «звучання ІІ».
 * Моделі тут лише підказка хештегів і текст листа: хто бренд і з ким працював, рахує код за даними Instagram.
 */

export const ITEM_USD = PRICE.post;
export const MAX_TAGS = 4;
export const PITCH_BATCH = 20;

export function estimateScoutUsd(s: { tags: number; postsPerTag: number; maxCreators: number; maxBrands: number }): number {
  return Math.round((s.tags * s.postsPerTag + s.maxCreators + s.maxBrands) * ITEM_USD * 100) / 100;
}

const HANDLE = /^[a-z0-9._]{2,30}$/;
/** Платформи й сервіси, які відмічають у дописах, але писати їм як бренду безглуздо. */
const NOT_BRANDS = new Set([
  "instagram", "creators", "tiktok", "youtube", "facebook", "meta", "threads", "reels", "explore", "linktree", "amazon", "amazonfashion",
  "amazoninfluencer", "ltk.it", "shopltk", "liketoknow.it", "shopmy", "ugc", "ugccreator", "ugccreators", "canva", "capcut", "later", "collabstr",
]);
/** Категорії профілю, за якими це людина, а не бренд. */
const PERSON_CATEGORY = /(creator|blogger|\bblog\b|public figure|artist|photographer|videographer|musician|band|athlete|influencer|model|gamer|comedian|writer|author|personal|actor|actress|dancer|journalist|coach|trainer|chef|host|editor|stylist)/i;
/** Агентства й площадки співпраць: їхні спільні дописи з авторами — не реклама бренду. */
export const AGENCY = /(agency|agencia|agence|mgmt|management|talents?(?!ed)|publicidad|marketing|influencers?(?=[._]|$)|collabs?(?=[._]|$)|\bpr\b|ugcagency|creatorhub)/i;
/** Імена на кшталт «sora.rojasugc» чи «ugc_bylily» — автори, а не бренди. */
const CREATOR_HANDLE = /ugc|creates|creator|influenc/i;
const SOCIAL = /(^|\.)(instagram|tiktok|youtube|facebook|twitter|x|threads|pinterest|snapchat|wa|whatsapp|t)\.(com|me|net)$/;

const hostOf = (url: string | null) => {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "").toLowerCase() : null;
  } catch {
    return null;
  }
};
/** Сайт бренду: не мультипосилання й не соцмережа (там email не шукаємо). */
export const isRealSite = (url: string | null) => {
  const h = hostOf(url);
  return !!h && !LINK_HUB.test(h) && !SOCIAL.test(h);
};

const str = (v: unknown) => (typeof v === "string" && v.trim() && v.trim() !== "None" ? v.trim() : null);

/** Чи це бренд — за полями профілю Instagram, без моделі. */
export function brandVerdict(raw: any): { verdict: BrandVerdict; why: string } {
  if (!raw) return { verdict: "unsure", why: "профіль не зібрано" };
  if (raw.private === true) return { verdict: "not_brand", why: "закритий профіль" };
  const cat = str(raw.businessCategoryName);
  const site = str(raw.externalUrl);
  if (cat && PERSON_CATEGORY.test(cat)) return { verdict: "not_brand", why: `категорія «${cat}»: це людина, а не бренд` };
  if (cat) return { verdict: "brand", why: `категорія «${cat}»` };
  if (raw.isBusinessAccount === true && isRealSite(site)) return { verdict: "brand", why: "бізнес-акаунт із власним сайтом" };
  if (isRealSite(site) && /(shop|store|official|®|™|\bbrand\b|ships|shipping|order|founded|est\.? ?\d{4}|made in|handmade)/i.test(str(raw.biography) ?? "")) {
    return { verdict: "brand", why: "власний сайт і магазинні слова в біо" };
  }
  return { verdict: "unsure", why: "категорії бізнесу немає: перевірте вручну" };
}

export type CreatorPosts = { creator: string; followers: number | null; posts: PostFacts[] };

/** Бренди з рекламних дописів: бренд → докази (кожен допис один раз). Відмітки інших авторів вибірки — не бренди. */
export function collectCollabs(creators: CreatorPosts[], skip: Set<string> = new Set()): { collabs: Map<string, BrandCollab[]>; adPosts: number } {
  const collabs = new Map<string, BrandCollab[]>();
  let adPosts = 0;
  for (const c of creators) {
    for (const p of c.posts) {
      const ad = detectAd(p, c.creator);
      if (!ad) continue;
      adPosts++;
      for (const raw of ad.brands) {
        const b = raw.toLowerCase().replace(/^@/, "").replace(/[.]+$/, "");
        if (!HANDLE.test(b) || b === c.creator || skip.has(b) || NOT_BRANDS.has(b) || CREATOR_HANDLE.test(b)) continue;
        const list = collabs.get(b) ?? [];
        if (!list.some((x) => x.postUrl === p.url)) {
          list.push({ creator: c.creator, followers: c.followers, postUrl: p.url, reason: ad.reason, paid: p.paid === true, at: p.publishedAt?.toISOString() ?? null });
        }
        collabs.set(b, list);
      }
    }
  }
  return { collabs, adPosts };
}

const distinctCreators = (cs: BrandCollab[]) => new Set(cs.map((c) => c.creator)).size;

/** Спершу бренди, з якими працювало більше різних авторів і з позначкою «Платне партнерство». */
export function rankCollabs(collabs: Map<string, BrandCollab[]>): [string, BrandCollab[]][] {
  const score = (cs: BrandCollab[]) => distinctCreators(cs) * 3 + cs.filter((c) => c.paid).length * 2 + cs.length;
  return [...collabs.entries()].sort((a, b) => score(b[1]) - score(a[1]) || a[0].localeCompare(b[0]));
}

const BAD_EMAIL = /^(no-?reply|donotreply|do-not-reply|privacy|abuse|postmaster|webmaster|example|test|email|your|name)@|@(sentry|wixpress|example|domain|email|sentry-next|mysite)\.|\.(png|jpe?g|gif|webp|svg)$/i;
const EMAIL_RANK = [/^(partner|collab|influenc|creator|ambassador|affiliate)/i, /^(marketing|pr|press|media|brand)/i, /^(hello|hi|hey|team|contact|info)/i];

/** Найкраща адреса для пропозиції співпраці: спершу партнерства, потім маркетинг, потім загальна; свій домен перед чужим. */
export function pickEmail(emails: string[], site: string | null): string | null {
  const domain = hostOf(site);
  const good = [...new Set(emails.map((e) => e.toLowerCase()))].filter((e) => !BAD_EMAIL.test(e));
  const rank = (e: string) => {
    const i = EMAIL_RANK.findIndex((r) => r.test(e));
    return (i < 0 ? EMAIL_RANK.length : i) + (domain && e.endsWith(`@${domain}`) ? 0 : 0.5);
  };
  return good.sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

const decode = (v: string) => {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
};

/** Адреси зі сторінки сайту бренду: посилання mailto і видимий текст (свій домен тут якраз потрібен). */
export function pageEmails(html: string): string[] {
  const mailto = [...html.matchAll(/mailto:([^"'?\s>]+)/gi)].map((m) => decode(m[1]));
  const text = html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&#64;|&commat;/g, "@");
  return extractEmails([...mailto, text].join(" "));
}

/** Email на сайті бренду: головна, потім типові сторінки контактів. Звичайні запити, без обходу захисту. */
export async function siteEmail(website: string): Promise<{ email: string; url: string } | null> {
  let origin: string;
  try {
    origin = new URL(website).origin;
  } catch {
    return null;
  }
  const pages = [...new Set([website, `${origin}/pages/contact`, `${origin}/contact`, `${origin}/contact-us`])];
  for (const url of pages) {
    let html: string;
    try {
      html = (await fetchLocalHtml(url)).html;
    } catch {
      continue;
    }
    if (isChallenge(html)) return null; // сайт закритий від ботів — далі не стукаємо
    const email = pickEmail(pageEmails(html), website);
    if (email) return { email, url };
  }
  return null;
}

type Resolver = Parameters<typeof checkEmail>[1];

async function rawOf(db: Db, ids: number[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await db.select({ raw: contentItems.raw }).from(contentItems).where(inArray(contentItems.id, ids.slice(i, i + 500)));
    out.push(...rows.map((r) => r.raw).filter((r) => r != null));
  }
  return out;
}

const verdictOrder: Record<BrandVerdict, number> = { brand: 0, unsure: 1, not_brand: 2 };
export const sortLeads = (leads: BrandLead[]) =>
  [...leads].sort((a, b) => verdictOrder[a.verdict] - verdictOrder[b.verdict] || Number(!!b.email) - Number(!!a.email)
    || distinctCreators(b.collabs) - distinctCreators(a.collabs) || b.collabs.length - a.collabs.length);

/** Повний прохід: хештеги → автори → реклама → профілі брендів → email. */
export async function runScout(db: Db, scout: BrandScout, opts: { resolveMx?: Resolver } = {}): Promise<void> {
  const stats: BrandScoutStats = { posts: 0, creators: 0, adPosts: 0, candidates: 0, brandProfiles: 0, withEmail: 0, costUsd: 0, notes: [] };
  const stage = (s: string) => db.update(brandScouts).set({ stage: s, stats, updatedAt: new Date() }).where(eq(brandScouts.id, scout.id));

  let tags = scout.hashtags.slice(0, MAX_TAGS);
  if (!tags.length) {
    await stage("Підбираю хештеги ніші");
    const s = await suggestFromBrief(db, `Creators who post about ${scout.niche} and do paid collaborations with brands: sponsored posts, gifted products, UGC.`, "ugc");
    tags = s.hashtags.slice(0, MAX_TAGS);
    if (!tags.length) throw new Error("Модель не запропонувала хештегів: впишіть їх вручну");
    await db.update(brandScouts).set({ hashtags: tags }).where(eq(brandScouts.id, scout.id));
  }

  // 1. Дописи з хештегів.
  const tagPosts: PostFacts[] = [];
  for (const [i, tag] of tags.entries()) {
    await stage(`Збираю дописи #${tag} (${i + 1} з ${tags.length})`);
    const r = await collect(db, { type: "instagram-hashtag", tag, limit: scout.postsPerTag });
    stats.costUsd += r.costUsd;
    stats.notes.push(...r.notes.map((n) => `#${tag}: ${n}`));
    tagPosts.push(...(await rawOf(db, r.ids)).map(postFactsFromRaw).filter((p): p is PostFacts => p != null && !!p.owner));
  }
  stats.posts = tagPosts.length;

  // 2. Автори: ті, хто частіше постить у ніші, — їхні останні дописи.
  const counts = new Map<string, number>();
  for (const p of tagPosts) counts.set(p.owner!, (counts.get(p.owner!) ?? 0) + 1);
  const authors = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, scout.maxCreators).map(([u]) => u);
  await stage(`Збираю профілі ${authors.length} авторів`);
  const profiles = new Map<string, any>();
  if (authors.length) {
    const { batch } = await collectProfiles(db, authors);
    stats.costUsd += batch.costUsd ?? 0;
    for (const c of batch.collected) if (c.item.kind === "profile" && c.raw) profiles.set(String((c.raw as any).username).toLowerCase(), c.raw);
  }
  const creatorPosts: CreatorPosts[] = [];
  for (const a of authors) {
    const raw = profiles.get(a);
    if (raw && brandVerdict(raw).verdict === "brand") continue; // сам бренд, а не автор
    if (AGENCY.test(`${a} ${str(raw?.fullName) ?? ""}`)) continue; // агенція публікує разом з авторами — це не бренди
    creatorPosts.push({ creator: a, followers: typeof raw?.followersCount === "number" ? raw.followersCount : null, posts: mergePosts(raw ? profilePosts(raw) : [], tagPosts.filter((p) => p.owner === a)) });
  }
  stats.creators = creatorPosts.length;

  // 3. Реклама й бренди в ній.
  const { collabs, adPosts } = collectCollabs(creatorPosts, new Set(creatorPosts.map((c) => c.creator)));
  stats.adPosts = adPosts;
  stats.candidates = collabs.size;
  const top = rankCollabs(collabs).slice(0, scout.maxBrands);

  // 4. Профілі брендів (ті, що вже зібрані як автори, — без повторної оплати).
  const need = top.map(([h]) => h).filter((h) => !profiles.has(h));
  if (need.length) {
    await stage(`Перевіряю ${need.length} профілів брендів`);
    const { batch } = await collectProfiles(db, need);
    stats.costUsd += batch.costUsd ?? 0;
    for (const c of batch.collected) if (c.item.kind === "profile" && c.raw) profiles.set(String((c.raw as any).username).toLowerCase(), c.raw);
  }
  const leads: BrandLead[] = [];
  for (const [handle, cs] of top) {
    const raw = profiles.get(handle);
    if (!raw) continue; // профілю немає (видалено чи перейменовано)
    stats.brandProfiles++;
    const v = brandVerdict(raw);
    const website = str(raw.externalUrl);
    const bioEmail = pickEmail(extractEmails(str(raw.biography)), website);
    leads.push({
      handle, name: str(raw.fullName), bio: str(raw.biography)?.slice(0, 400) ?? null, category: str(raw.businessCategoryName),
      followers: typeof raw.followersCount === "number" ? raw.followersCount : null, website,
      email: bioEmail, emailSource: bioEmail ? "біо Instagram" : null, verdict: v.verdict, verdictWhy: v.why, collabs: cs.slice(0, 10),
    });
  }

  // 5. Email на сайтах (лише бренди й сумнівні, без email у біо).
  const toVisit = leads.filter((l) => l.verdict !== "not_brand" && !l.email && isRealSite(l.website));
  for (const [i, l] of toVisit.entries()) {
    if (i % 5 === 0) await stage(`Шукаю email на сайтах брендів (${i} з ${toVisit.length})`);
    const found = await siteEmail(l.website!).catch(() => null);
    if (found) {
      l.email = found.email;
      l.emailSource = found.url;
    }
  }
  // Адреси без поштового сервера не залишаємо: лист однаково повернеться.
  for (const l of leads.filter((x) => x.email)) {
    const check = await checkEmail(l.email!, opts.resolveMx);
    if (!usable(check)) {
      l.email = null;
      l.emailSource = null;
    }
  }
  stats.withEmail = leads.filter((l) => l.email && l.verdict !== "not_brand").length;
  stats.costUsd = Math.round(stats.costUsd * 1000) / 1000;
  await db.update(brandScouts).set({ status: "done", stage: null, stats, brands: sortLeads(leads), updatedAt: new Date() }).where(eq(brandScouts.id, scout.id));
}

export async function createScout(db: Db, input: { niche: string; hashtags: string[]; postsPerTag: number; maxCreators: number; maxBrands: number; creator: BrandCreator | null }): Promise<number> {
  const hashtags = [...new Set(input.hashtags.map((t) => t.replace(/^#/, "").toLowerCase().replace(/[^\p{L}\p{N}_]/gu, "")).filter((t) => t.length >= 2))].slice(0, MAX_TAGS);
  const [row] = await db.insert(brandScouts).values({ ...input, hashtags }).returning({ id: brandScouts.id });
  return row.id;
}

/* ---------- Лист від креатора бренду ---------- */

const PitchSchema = z.object({ subject: z.string().catch(""), body: z.string().catch(""), translation_uk: z.string().catch("") });

const PITCH_SYSTEM = `You write a short cold email from a content creator to a brand, asking to work together. ${GUARD}
${HUMAN_RULES}
Rules:
- Use only CREATOR facts and the brand data. Never invent numbers, results, past brands, links, prices or dates. Skip empty fields.
- Open with one specific thing about the brand taken from its name or bio (what they make). Never praise in general words.
- If collab_examples is not empty, you may say you saw they work with creators like one of those handles.
- One or two lines on who the creator is and what they offer (creator.about, creator.niche, creator.followers, creator.offer).
- Put creator.portfolio as a plain link if it is given.
- End with one easy question (a trial video, or whether to send rates).
- 3-4 short paragraphs separated by a blank line. The last line is creator.name alone.
- Body 50-120 words. Subject max 7 words, plain, no clickbait, no emojis.
Return ONLY JSON: {"subject": "...", "body": "...", "translation_uk": "the body in Ukrainian"}`;

const URL_RE = /https?:\/\/[^\s)>\]]+/gi;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/i;

export type PitchFacts = {
  creator: Omit<BrandCreator, "style">;
  brand: { handle: string; name: string | null; bio: string | null; category: string | null; website: string | null };
  collab_examples: string[];
};

export function pitchFacts(c: BrandCreator, b: BrandLead): PitchFacts {
  const { style: _style, ...creator } = c;
  // Лише «охайні» імена (без ___ і цифрових хвостів): дивне ім’я в листі виглядає як помилка.
  const tidyHandle = (h: string) => h.length <= 20 && /^[a-z][a-z0-9]*([._][a-z0-9]+){0,2}$/.test(h) && !/\d{3,}/.test(h);
  const examples = [...new Set([...b.collabs].sort((x, y) => (y.followers ?? 0) - (x.followers ?? 0)).map((x) => x.creator))].filter(tidyHandle).slice(0, 2).map((h) => `@${h}`);
  return { creator, brand: { handle: `@${b.handle}`, name: b.name, bio: b.bio, category: b.category, website: b.website }, collab_examples: examples };
}

/** Перевірка листа: усе конкретне (числа, посилання, @імена) має бути у фактах. */
export function checkPitch(subject: string, body: string, f: PitchFacts): string[] {
  const issues: string[] = [];
  const text = `${subject}\n${body}`;
  const allowedText = JSON.stringify(f).toLowerCase();
  const allowed = numTokens(allowedText);
  const plain = text.replace(URL_RE, " ").replace(new RegExp(EMAIL_RE.source, "gi"), " ");
  for (const n of numTokens(plain)) if (!allowed.has(n)) issues.push(`число «${n}» відсутнє у фактах`);
  for (const u of new Set((text.match(URL_RE) ?? []).map((x) => x.replace(/[.,]+$/, "").toLowerCase()))) if (!allowedText.includes(u)) issues.push(`посилання ${u} відсутнє у фактах`);
  for (const h of new Set((plain.match(/(?<![\w.])@[a-z0-9._]{2,30}/gi) ?? []).map((x) => x.replace(/[.]+$/, "").toLowerCase()))) {
    if (!allowedText.includes(h)) issues.push(`ім’я ${h} відсутнє у фактах`);
  }
  if (EMAIL_RE.test(body)) issues.push("у тексті є email: він і так у полі «Від»");
  if (looksLikePhone(plain)) issues.push("у тексті схоже на номер телефону");
  if (/\{\{|\}\}|\[[A-Z _]+\]/.test(text)) issues.push("у тексті лишився шаблон");
  if (/\b(null|undefined|NaN)\b/.test(text)) issues.push("у тексті є службове слово null/undefined");
  if (!subject.trim()) issues.push("немає теми листа");
  if (!body.trim()) issues.push("порожній лист");
  else if (f.creator.name && !body.trim().split("\n").at(-1)!.toLowerCase().includes(f.creator.name.toLowerCase())) issues.push(`лист не підписано іменем ${f.creator.name}`);
  const lang = detectLanguage(body).language;
  if (lang && lang !== "en") issues.push(`текст не англійською (${lang})`);
  if (body.split(/\s+/).length > 160) issues.push("лист задовгий");
  return [...new Set(issues)];
}

export async function writeBrandPitch(db: Db, c: BrandCreator, b: BrandLead): Promise<NonNullable<BrandLead["pitch"]>> {
  const f = pitchFacts(c, b);
  const style = (c.style ?? "").split(/\n-{3,}\n/).map((s) => s.trim()).filter(Boolean).slice(0, 3);
  const { brand, ...trusted } = f;
  const messages = [
    { role: "system" as const, content: PITCH_SYSTEM },
    { role: "user" as const, content: `CREATOR (trusted):\n${JSON.stringify(trusted, null, 1)}\n${styleBlock(style)}\n${dataBlock("brand", JSON.stringify(brand, null, 1))}` },
  ];
  const review = (r: z.infer<typeof PitchSchema>) => {
    const subject = humanize(r.subject).replace(/\s+/g, " ").trim();
    const body = humanize(r.body);
    return { subject, body, bodyUk: r.translation_uk.trim(), issues: [...checkPitch(subject, body, f), ...tellIssues(`${subject}\n${body}`)] };
  };
  const res = await chatJsonMeta(db, PitchSchema, messages, { purpose: "brand-pitch", maxTokens: 700, cache: false });
  let out = review(res.data);
  if (out.issues.length) {
    const retry = await chatJsonMeta(db, PitchSchema, [
      ...messages, { role: "assistant", content: JSON.stringify(res.data) },
      { role: "user", content: `Fix these problems and return the full corrected JSON: ${out.issues.join("; ")}. Remove anything that is not in the facts. Keep it sounding like a real person.` },
    ], { purpose: "brand-pitch", maxTokens: 700, cache: false });
    const again = review(retry.data);
    if (again.issues.length < out.issues.length) out = again;
  }
  return out;
}

async function saveLead(db: Db, id: number, handle: string, change: (l: BrandLead) => BrandLead, dequeue = false): Promise<void> {
  // Читаємо свіжий рядок: між кроками ви могли змінити вердикт чи профіль.
  const [s] = await db.select().from(brandScouts).where(eq(brandScouts.id, id));
  if (!s) return;
  await db.update(brandScouts).set({
    brands: s.brands.map((l) => (l.handle === handle ? change(l) : l)),
    ...(dequeue ? { pitchQueue: s.pitchQueue.filter((h) => h !== handle) } : {}),
    updatedAt: new Date(),
  }).where(eq(brandScouts.id, id));
}

export async function pitchBrand(db: Db, s: BrandScout, handle: string): Promise<NonNullable<BrandLead["pitch"]>> {
  if (!s.creator) throw new Error("Спершу заповніть дані креатора");
  const lead = s.brands.find((l) => l.handle === handle);
  if (!lead) throw new Error("Бренд не знайдено");
  const pitch = await writeBrandPitch(db, s.creator, lead);
  await saveLead(db, s.id, handle, (l) => ({ ...l, pitch }), true);
  return pitch;
}

/** У чергу на листи: бренди з email без листа (до PITCH_BATCH). */
export async function queuePitches(db: Db, s: BrandScout): Promise<number> {
  const handles = s.brands.filter((l) => l.verdict === "brand" && l.email && !l.pitch).slice(0, PITCH_BATCH).map((l) => l.handle);
  await db.update(brandScouts).set({ pitchQueue: handles, updatedAt: new Date() }).where(eq(brandScouts.id, s.id));
  return handles.length;
}

export async function setBrandVerdict(db: Db, id: number, handle: string, verdict: BrandVerdict): Promise<void> {
  await saveLead(db, id, handle, (l) => ({ ...l, verdict, byYou: true, verdictWhy: verdict === "brand" ? "ви позначили як бренд" : verdict === "not_brand" ? "ви позначили: не бренд" : l.verdictWhy }));
}

const STALE_MS = 30 * 60_000;

/** Після перезапуску сервера перерваний пошук брендів іде в чергу знову (дописи з кешу збору не оплачуються вдруге). */
export async function requeueScouts(db: Db): Promise<void> {
  await db.update(brandScouts).set({ status: "queued", stage: null }).where(eq(brandScouts.status, "running"));
}

/** Крок фонового виконавця: спершу нові пошуки брендів, потім по одному листу з черги. */
export async function runBrandScouts(db: Db): Promise<boolean> {
  const [s] = await db.select().from(brandScouts)
    .where(or(eq(brandScouts.status, "queued"), and(eq(brandScouts.status, "running"), lt(brandScouts.updatedAt, new Date(Date.now() - STALE_MS)))))
    .orderBy(asc(brandScouts.id)).limit(1);
  if (s) {
    await db.update(brandScouts).set({ status: "running", error: null, updatedAt: new Date() }).where(eq(brandScouts.id, s.id));
    try {
      await runScout(db, s);
    } catch (e) {
      await db.update(brandScouts).set({ status: "failed", stage: null, error: (e instanceof Error ? e.message : String(e)).slice(0, 500), updatedAt: new Date() }).where(eq(brandScouts.id, s.id));
    }
    return true;
  }
  const [q] = await db.select().from(brandScouts).where(and(eq(brandScouts.status, "done"), sql`jsonb_array_length(${brandScouts.pitchQueue}) > 0`)).orderBy(asc(brandScouts.id)).limit(1);
  if (!q) return false;
  const handle = q.pitchQueue[0];
  try {
    await pitchBrand(db, q, handle);
  } catch (e) {
    if (e instanceof LlmUnavailableError) return false; // модель зайнята — наступного разу
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 160);
    await saveLead(db, q.id, handle, (l) => ({ ...l, pitch: { subject: "", body: "", bodyUk: "", issues: [`Не вдалося написати: ${msg}`] } }), true);
  }
  return true;
}

/** Файл для креатора: бренди (без «не бренд»), контакти, докази співпраці й готовий лист. */
export function brandsCsv(s: BrandScout): { csv: string; rows: number } {
  const head = ["brand", "instagram", "name", "category", "followers", "website", "email", "creators_worked_with", "example_creators", "example_post", "last_collab", "paid_partnership", "email_subject", "email_body"];
  const rows = s.brands.filter((l) => l.verdict !== "not_brand").map((l) => {
    const last = l.collabs.map((c) => c.at).filter((x): x is string => !!x).sort().at(-1);
    return [
      l.handle, `https://www.instagram.com/${l.handle}/`, l.name ?? "", l.category ?? "", l.followers ?? "", l.website ?? "", l.email ?? "",
      distinctCreators(l.collabs), [...new Set(l.collabs.map((c) => c.creator))].slice(0, 3).join(", "), l.collabs[0]?.postUrl ?? "",
      last ? last.slice(0, 10) : "", l.collabs.some((c) => c.paid) ? "yes" : "", l.pitch?.subject ?? "", l.pitch?.body ?? "",
    ];
  });
  return { csv: toCsv(head, rows), rows: rows.length };
}

export { distinctCreators };
