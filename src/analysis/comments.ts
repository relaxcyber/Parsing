import { z } from "zod";
import type { Db } from "@/db/client";
import { detectLanguage } from "@/enrich/geo";
import { chatJsonMeta, dataBlock, GUARD } from "@/llm/client";
import { groundTri, triClaim, verifiedQuotes, type TriClaim } from "@/llm/evidence";
import type { CommentFacts } from "./posts";
import type { CommentSignals } from "./trust";

/**
 * Реакція аудиторії за вибіркою коментарів. Цифри рахує код (частка порожніх коментарів, повтори,
 * одні й ті самі коментатори, питання «де купити»), а модель лише читає зміст — з цитатами.
 */

export const COMMENTS_PROMPT_VERSION = "comments-v1";
const GENERIC = /^(?:[\p{Emoji_Presentation}\p{Extended_Pictographic}\s❤♥️!.]+|(?:so\s+)?(?:nice|wow|love( it| this)?|amazing|great|beautiful|gorgeous|cute|awesome|perfect|cool|super|top|fire|yes+|omg|wonderful|stunning|lovely|клас|супер|топ|круто|гарно|красиво|вау)[\s!.\p{Emoji_Presentation}\p{Extended_Pictographic}]*)$/iu;
const QUESTION = /(where (can|do) i (get|buy)|how much|price|link\??$|what (brand|product)|is it worth|де купити|скільки коштує|ціна|где купить|сколько стоит|\?)/i;

export type CommentMetrics = CommentSignals & {
  posts: number;
  duplicateShare: number;
  creatorReplyShare: number;
  questionShare: number;
  sample: string[];
};

const share = (n: number, d: number) => (d ? Math.round((n / d) * 100) / 100 : 0);

export function commentMetrics(comments: CommentFacts[], creator: string, creatorLanguage: string | null): CommentMetrics {
  const fromOthers = comments.filter((c) => c.owner !== creator);
  const replies = comments.filter((c) => c.owner === creator).length;
  const texts = fromOthers.map((c) => c.text.trim());
  const counts = new Map<string, number>();
  for (const t of texts) counts.set(t.toLowerCase(), (counts.get(t.toLowerCase()) ?? 0) + 1);
  const duplicates = [...counts.values()].filter((n) => n > 1).reduce((a, n) => a + n, 0);

  // Одні й ті самі коментатори під кількома дописами.
  const postsBy = new Map<string, Set<string>>();
  for (const c of fromOthers) if (c.owner) postsBy.set(c.owner, (postsBy.get(c.owner) ?? new Set()).add(c.postUrl ?? ""));
  const posts = new Set(fromOthers.map((c) => c.postUrl ?? "")).size;
  const repeat = posts >= 2 ? fromOthers.filter((c) => c.owner && (postsBy.get(c.owner)?.size ?? 0) >= 2).length : 0;

  let foreign: number | null = null;
  if (creatorLanguage) {
    const langs = texts.filter((t) => t.split(/\s+/).length >= 4).map((t) => detectLanguage(t).language).filter((l): l is string => !!l);
    foreign = langs.length >= 8 ? share(langs.filter((l) => l !== creatorLanguage).length, langs.length) : null;
  }
  return {
    total: fromOthers.length,
    posts,
    genericShare: share(texts.filter((t) => GENERIC.test(t)).length, texts.length),
    duplicateShare: share(duplicates, texts.length),
    repeatCommenterShare: share(repeat, fromOthers.length),
    creatorReplyShare: share(replies, comments.length),
    questionShare: share(texts.filter((t) => QUESTION.test(t)).length, texts.length),
    foreignShare: foreign,
    sample: texts.filter((t) => !GENERIC.test(t)).slice(0, 12),
  };
}

const CommentsReplySchema = z.object({
  sentiment: z.enum(["positive", "mixed", "negative", "unknown"]).catch("unknown"),
  purchase_intent: triClaim,
  bot_like: triClaim,
  trusts_creator: triClaim,
  ad_reaction: z.object({ summary: z.string().catch(""), evidence: z.array(z.string()).catch([]) }).catch({ summary: "", evidence: [] }),
  summary: z.string().catch(""),
});

export type CommentsAnalysis = {
  version: string;
  sentiment: "positive" | "mixed" | "negative" | "unknown";
  purchaseIntent: TriClaim;
  botLike: TriClaim;
  trustsCreator: TriClaim;
  adReaction: { summary: string; evidence: string[] } | null;
  summary: string;
  dropped: number;
};

const SYSTEM = `You read a sample of Instagram comments left under one creator's posts and describe how the audience reacts.
${GUARD}
Rules: every "yes" needs 1-3 quotes copied character-for-character from the comments; otherwise answer "unknown". Comments marked [AD] are under sponsored posts.
Return ONLY JSON:
{
 "sentiment": "positive"|"mixed"|"negative"|"unknown",
 "purchase_intent": {"value": "yes"|"no"|"unknown", "evidence": [quotes]},   // people ask where to buy, price, links
 "bot_like": {"value": "yes"|"no"|"unknown", "evidence": [quotes]},          // templated, off-topic or spammy comments
 "trusts_creator": {"value": "yes"|"no"|"unknown", "evidence": [quotes]},    // people say they bought or tried something because of the creator
 "ad_reaction": {"summary": "one sentence about reactions under [AD] posts, empty if none", "evidence": [quotes]},
 "summary": "one sentence a marketer can read"
}`;

export async function analyzeComments(db: Db, comments: (CommentFacts & { ad?: boolean })[], creator: string): Promise<CommentsAnalysis> {
  const own = comments.filter((c) => c.owner !== creator).slice(0, 60);
  const text = own.map((c, i) => `[${i + 1}]${c.ad ? " [AD]" : ""} ${c.text.replace(/\s+/g, " ").slice(0, 200)}`).join("\n");
  const res = await chatJsonMeta(db, CommentsReplySchema, [
    { role: "system", content: SYSTEM },
    { role: "user", content: dataBlock("comments", text) },
  ], { purpose: "comments-analysis", maxTokens: 600 });
  const corpus = own.map((c) => c.text).join("\n");
  let dropped = 0;
  const g = (c: TriClaim) => {
    const r = groundTri(c, corpus);
    if (r.dropped) dropped++;
    return { value: r.value, evidence: r.evidence };
  };
  const adEvidence = verifiedQuotes(res.data.ad_reaction.evidence, corpus);
  return {
    version: COMMENTS_PROMPT_VERSION,
    sentiment: res.data.sentiment,
    purchaseIntent: g(res.data.purchase_intent),
    botLike: g(res.data.bot_like),
    trustsCreator: g(res.data.trusts_creator),
    adReaction: res.data.ad_reaction.summary && adEvidence.length ? { summary: res.data.ad_reaction.summary.slice(0, 300), evidence: adEvidence } : null,
    summary: res.data.summary.slice(0, 300),
    dropped,
  };
}
