import { z } from "zod";
import type { Db } from "@/db/client";
import { chatJsonMeta, dataBlock, GUARD } from "@/llm/client";
import { groundTri, normText, triClaim, verifiedQuotes, type TriClaim } from "@/llm/evidence";
import type { PostFacts } from "./posts";

/**
 * Аналіз тексту профілю мовною моделлю: хто це (людина, бізнес, агенція), яка роль і ніша,
 * мова, країна, наскільки підходить під бриф. Кожен висновок — з дослівною цитатою; цитату
 * перевіряє код, і висновок без підтвердженої цитати стає «невідомо».
 */

export const PROFILE_PROMPT_VERSION = "profile-v1";

const ACCOUNT_TYPES = ["individual_creator", "business_or_brand", "agency_or_platform", "fan_or_meme_page", "unknown"] as const;
const quotes = z.array(z.string()).catch([]);

export const ProfileReplySchema = z.object({
  account_type: z.object({ value: z.enum(ACCOUNT_TYPES).catch("unknown"), evidence: quotes }).catch({ value: "unknown", evidence: [] }),
  ugc_creator: triClaim,
  affiliate: triClaim,
  open_to_collabs: triClaim,
  niches: z.array(z.object({ name: z.string().max(40), evidence: quotes })).max(8).catch([]),
  content_language: z.object({ value: z.string().catch("unknown"), evidence: quotes }).catch({ value: "unknown", evidence: [] }),
  country: z.object({ value: z.string().catch("unknown"), evidence: quotes }).catch({ value: "unknown", evidence: [] }),
  brief_fit: z.object({ score: z.number().int().min(1).max(5).nullable().catch(null), reason: z.string().catch(""), evidence: quotes })
    .catch({ score: null, reason: "", evidence: [] }),
  summary: z.string().catch(""),
});

export type ProfileAnalysis = {
  version: string;
  model: string;
  accountType: { value: (typeof ACCOUNT_TYPES)[number]; evidence: string[] };
  ugcCreator: TriClaim;
  affiliate: TriClaim;
  openToCollabs: TriClaim;
  niches: { name: string; evidence: string[] }[];
  language: string | null;
  country: { value: string; evidence: string[] } | null;
  briefFit: { score: number; reason: string; evidence: string[] } | null;
  summary: string;
  /** Скільки тверджень моделі відкинуто через відсутність підтвердженої цитати. */
  dropped: number;
};

const SYSTEM = `You are an analyst on a creator-sourcing team. You judge one Instagram account using ONLY the data blocks you receive.
${GUARD}
Rules:
- Every answer other than "unknown" needs evidence: 1-3 short quotes copied character-for-character from the data (each under 120 characters). Quote the words; do not paraphrase.
- If the data does not show something, answer "unknown". "unknown" is always better than a guess.
- Do not infer anything from the username alone. Do not infer the country from the language.
- business_or_brand = a shop, product brand or service business; agency_or_platform = an agency, management company, marketplace or community of creators; fan_or_meme_page = reposts other people's content.
Return ONLY a JSON object:
{
 "account_type": {"value": "individual_creator"|"business_or_brand"|"agency_or_platform"|"fan_or_meme_page"|"unknown", "evidence": [quotes]},
 "ugc_creator": {"value": "yes"|"no"|"unknown", "evidence": [quotes]},   // makes content for brands to use in their ads
 "affiliate": {"value": "yes"|"no"|"unknown", "evidence": [quotes]},     // earns from affiliate links, storefronts, promo codes
 "open_to_collabs": {"value": "yes"|"no"|"unknown", "evidence": [quotes]},
 "niches": [{"name": "1-3 words in English", "evidence": [quotes]}],      // at most 5, most prominent first
 "content_language": {"value": "two-letter ISO 639-1 code or unknown", "evidence": [quotes]},
 "country": {"value": "two-letter ISO 3166 code or unknown", "evidence": [quotes]},   // only if a place is named
 "brief_fit": {"score": 1-5 or null, "reason": "one sentence", "evidence": [quotes]},  // null when there is no brief
 "summary": "one sentence a marketer can read"
}`;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function profileCorpus(input: { displayName?: string | null; bio?: string | null; posts: Pick<PostFacts, "caption">[] }) {
  return [input.displayName ?? "", input.bio ?? "", ...input.posts.map((p) => p.caption)].join("\n");
}

export async function analyzeProfile(
  db: Db,
  input: { username: string; displayName?: string | null; bio?: string | null; posts: PostFacts[]; brief?: string | null; focus: "ugc" | "affiliate" },
): Promise<ProfileAnalysis> {
  const posts = input.posts.filter((p) => p.caption.trim()).slice(0, 12);
  const profile = [`Display name: ${input.displayName ?? ""}`, `Bio: ${input.bio ?? ""}`].join("\n");
  const captions = posts.map((p, i) => `[${i + 1}] ${clip(p.caption.replace(/\s+/g, " "), 350)}`).join("\n") || "(no captions)";
  const brief = input.brief?.trim()
    ? `The team is looking for ${input.focus === "affiliate" ? "affiliate creators" : "UGC creators"} for this brief (written by the team, trusted):\n${clip(input.brief.trim(), 1200)}`
    : "There is no brief: set brief_fit.score to null.";
  const res = await chatJsonMeta(db, ProfileReplySchema, [
    { role: "system", content: SYSTEM },
    { role: "user", content: `${brief}\n\n${dataBlock("profile", profile)}\n\n${dataBlock("captions", captions)}` },
  ], { purpose: "profile-analysis", maxTokens: 900 });
  return groundProfile(res.data, profileCorpus({ ...input, posts }), res.model);
}

/** Перевірка цитат: що не підтверджено даними — стає «невідомо». */
export function groundProfile(r: z.infer<typeof ProfileReplySchema>, corpus: string, model: string): ProfileAnalysis {
  let dropped = 0;
  const tri = (c: TriClaim) => {
    const g = groundTri(c, corpus);
    if (g.dropped) dropped++;
    return { value: g.value, evidence: g.evidence };
  };
  const typeEvidence = verifiedQuotes(r.account_type.evidence, corpus);
  const accountType = r.account_type.value !== "unknown" && typeEvidence.length === 0
    ? (dropped++, { value: "unknown" as const, evidence: [] })
    : { value: r.account_type.value, evidence: typeEvidence };
  const niches = r.niches
    .map((n) => ({ name: n.name.trim().toLowerCase(), evidence: verifiedQuotes(n.evidence, corpus) }))
    .filter((n) => {
      if (n.name && n.evidence.length) return true;
      dropped++;
      return false;
    })
    .slice(0, 5);
  const lang = /^[a-z]{2}$/.test(r.content_language.value) && normText(corpus).length > 40 ? r.content_language.value : null;
  const countryEvidence = verifiedQuotes(r.country.evidence, corpus);
  const countryCode = r.country.value.toUpperCase();
  const country = /^[A-Z]{2}$/.test(countryCode) && countryEvidence.length ? { value: countryCode === "UK" ? "GB" : countryCode, evidence: countryEvidence } : null;
  if (/^[A-Z]{2}$/.test(countryCode) && !country) dropped++;
  const fitEvidence = verifiedQuotes(r.brief_fit.evidence, corpus);
  const briefFit = r.brief_fit.score != null && fitEvidence.length ? { score: r.brief_fit.score, reason: r.brief_fit.reason.slice(0, 300), evidence: fitEvidence } : null;
  if (r.brief_fit.score != null && !briefFit) dropped++;
  return {
    version: PROFILE_PROMPT_VERSION, model, accountType,
    ugcCreator: tri(r.ugc_creator), affiliate: tri(r.affiliate), openToCollabs: tri(r.open_to_collabs),
    niches, language: lang, country, briefFit, summary: r.summary.slice(0, 300), dropped,
  };
}

/** Що аналіз означає для відбору. */
export function profileVerdict(a: ProfileAnalysis, focus: "ugc" | "affiliate") {
  const reasons: string[] = [];
  let reject: string | null = null;
  const q = (e: string[]) => (e[0] ? ` («${e[0].slice(0, 80)}»)` : "");
  if (a.accountType.value === "business_or_brand") reject = `не окремий автор — бізнес${q(a.accountType.evidence)}`;
  if (a.accountType.value === "agency_or_platform") reject = `не окремий автор — агенція чи платформа${q(a.accountType.evidence)}`;
  if (a.accountType.value === "fan_or_meme_page") reject = `сторінка репостів${q(a.accountType.evidence)}`;
  const role = focus === "affiliate" ? a.affiliate : a.ugcCreator;
  if (role.value === "yes") reasons.push(`${focus === "affiliate" ? "афіліат" : "UGC-креатор"} за текстом${q(role.evidence)}`);
  if (a.openToCollabs.value === "yes") reasons.push(`відкритий до співпраці${q(a.openToCollabs.evidence)}`);
  if (a.niches.length) reasons.push(`ніші: ${a.niches.map((n) => n.name).join(", ")}`);
  if (a.briefFit) reasons.push(`відповідність брифу ${a.briefFit.score}/5: ${a.briefFit.reason}`);
  // Fit від моделі: роль до 40, відповідність брифу до 60 (без брифу — роль на всю шкалу).
  const roleScore = role.value === "yes" ? 40 : role.value === "no" ? 0 : 15;
  const fit = a.briefFit ? roleScore + (a.briefFit.score - 1) * 15 : Math.round((roleScore / 40) * 100);
  return { reject, reasons, fit };
}
