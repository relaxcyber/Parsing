import { z } from "zod";
import type { Db } from "@/db/client";
import { chatJson } from "@/llm/client";

/**
 * Бриф словами → пропозиція параметрів пошуку. Це лише чернетка для форми: ви її правите
 * перед запуском. Конкурентів беремо тільки тих, кого названо в самому брифі (вигадати
 * «схожий бренд» модель може, а перевірити, що такий акаунт існує, без платного запиту не можна).
 */

const list = (max: number) => z.array(z.string()).catch([]).transform((a) => a.map((x) => x.trim()).filter(Boolean).slice(0, max));

const BriefReplySchema = z.object({
  hashtags: list(8),
  keywords: list(10),
  stop_words: list(10),
  bio_queries: list(5),
  competitors: list(5),
  countries: list(5),
  languages: list(3),
  formats: list(4),
  notes: z.string().catch(""),
});

export type BriefSuggestion = {
  hashtags: string[]; keywords: string[]; stopWords: string[]; bioQueries: string[]; competitors: string[];
  countries: string[]; languages: string[]; formats: string[]; notes: string;
};

const SYSTEM = `You help a creator-sourcing specialist set up an Instagram search from a client brief.
Return ONLY JSON:
{
 "hashtags": ["5-8 hashtags without #, that creators of the needed type actually use; mix niche tags with role tags like ugccreator"],
 "keywords": ["5-10 niche words to look for in bios and captions, in the content language"],
 "stop_words": ["words that mark accounts to skip, e.g. giveaway, wholesale"],
 "bio_queries": ["2-5 short phrases to search for in Instagram profile names and bios"],
 "competitors": ["Instagram handles of competitor brands ONLY if the brief names them; otherwise empty"],
 "countries": ["ISO 3166 two-letter codes if the brief names a market"],
 "languages": ["ISO 639-1 codes of the content language"],
 "formats": ["any of: talking_to_camera, product_demo, voiceover, subtitles — only if the brief asks"],
 "notes": "one or two sentences: what to check by hand"
}`;

const tag = (s: string) => s.replace(/^#/, "").toLowerCase().replace(/[^\p{L}\p{N}_]/gu, "");

export async function suggestFromBrief(db: Db, brief: string, focus: "ugc" | "affiliate"): Promise<BriefSuggestion> {
  const r = await chatJson(db, BriefReplySchema, [
    { role: "system", content: SYSTEM },
    { role: "user", content: `We look for ${focus === "affiliate" ? "affiliate creators (storefronts, promo codes)" : "UGC creators (content for brand ads)"}.\nBrief:\n${brief.slice(0, 3000)}` },
  ], { purpose: "brief-suggest", maxTokens: 700 });
  const lowerBrief = brief.toLowerCase();
  return {
    hashtags: [...new Set(r.hashtags.map(tag).filter((t) => t.length >= 3))],
    keywords: [...new Set(r.keywords.map((k) => k.toLowerCase()))],
    stopWords: [...new Set(r.stop_words.map((k) => k.toLowerCase()))],
    bioQueries: r.bio_queries,
    competitors: r.competitors.map((c) => c.replace(/^@/, "").toLowerCase()).filter((c) => /^[a-z0-9._]{2,30}$/.test(c) && lowerBrief.includes(c.replace(/[._]/g, "").slice(0, 5))),
    countries: r.countries.map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)),
    languages: r.languages.map((c) => c.toLowerCase()).filter((c) => /^[a-z]{2}$/.test(c)),
    formats: r.formats.filter((f) => ["talking_to_camera", "product_demo", "voiceover", "subtitles"].includes(f)),
    notes: r.notes.slice(0, 400),
  };
}
