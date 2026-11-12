import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { PostFacts } from "@/analysis/posts";
import type { ContentFormat } from "@/db/schema";
import type { Db } from "@/db/client";
import { chatJsonMeta, dataBlock, GUARD } from "@/llm/client";
import { quoteFound, Tri, validFrames, type TriValue } from "@/llm/evidence";
import { transcribe, type Transcript } from "@/llm/transcribe";
import { processVideo } from "./frames";
import { buildCollage, deepCollagePath, download, validImage } from "./vision";

/**
 * Глибокий аудит найкращих: кадри з перших секунд і з середини роликів (переважно рекламних),
 * розшифровка мовлення і бриф. Модель оцінює рекламну подачу: зачіпку, товар у дії, користь,
 * заклик, субтитри. Кожна оцінка — з номерами кадрів або цитатою з розшифровки, які перевіряє код.
 */
export const DEEP_VERSION = "deep-v1";

const triFrames = z.object({ value: Tri.catch("unknown"), frames: z.array(z.number()).catch([]), quote: z.string().catch("") })
  .catch({ value: "unknown", frames: [], quote: "" });

export const DeepReplySchema = z.object({
  hook: z.object({ score: z.number().int().min(1).max(5).nullable().catch(null), frames: z.array(z.number()).catch([]), quote: z.string().catch(""), note: z.string().catch("") })
    .catch({ score: null, frames: [], quote: "", note: "" }),
  speaks_to_camera: triFrames,
  product_in_use: triFrames,
  benefit_stated: triFrames,
  call_to_action: triFrames,
  subtitles: triFrames,
  delivery: z.object({ score: z.number().int().min(1).max(5).nullable().catch(null), note: z.string().catch("") }).catch({ score: null, note: "" }),
  brief_fit: z.object({ score: z.number().int().min(1).max(5).nullable().catch(null), reason: z.string().catch(""), frames: z.array(z.number()).catch([]) })
    .catch({ score: null, reason: "", frames: [] }),
  summary: z.string().catch(""),
});

type Claim = { value: TriValue; frames: number[]; quote: string | null };
export type DeepAudit = {
  version: string;
  model: string;
  frames: number;
  videos: number;
  transcript: Transcript | null;
  hook: { score: number | null; frames: number[]; quote: string | null; note: string };
  speaksToCamera: Claim;
  productInUse: Claim;
  benefitStated: Claim;
  callToAction: Claim;
  subtitles: Claim;
  delivery: { score: number | null; note: string };
  briefFit: { score: number; reason: string } | null;
  formats: ContentFormat[];
  summary: string;
  dropped: number;
};

const SYSTEM = `You review a UGC creator's video work for a brand that wants to order paid ads.
You get numbered frames (number in the corner) and, when available, a transcript of the creator's speech and the post captions.
Frames ${"{HOOK}"} are taken at the first second of a video (the hook). ${GUARD}
Rules: every "yes" needs frame numbers or a quote copied character-for-character from the transcript or captions. If you cannot point to it, answer "unknown".
Return ONLY JSON:
{
 "hook": {"score": 1-5 or null, "frames": [numbers], "quote": "opening words from the transcript or empty", "note": "what grabs or loses attention in the first second"},
 "speaks_to_camera": {"value": "yes"|"no"|"unknown", "frames": [numbers], "quote": ""},
 "product_in_use": {"value": "yes"|"no"|"unknown", "frames": [numbers], "quote": ""},       // the product is shown being used, not just held
 "benefit_stated": {"value": "yes"|"no"|"unknown", "frames": [], "quote": "words naming a concrete benefit"},
 "call_to_action": {"value": "yes"|"no"|"unknown", "frames": [], "quote": "words asking to buy, click, use a code"},
 "subtitles": {"value": "yes"|"no"|"unknown", "frames": [numbers], "quote": ""},
 "delivery": {"score": 1-5 or null, "note": "energy and clarity of speech; null without a transcript"},
 "brief_fit": {"score": 1-5 or null, "reason": "one sentence", "frames": [numbers]},   // null when there is no brief
 "summary": "one or two sentences a marketer can read"
}`;

/** Ролики для розбору: спершу рекламні, далі найсвіжіші. */
export function pickVideos(posts: PostFacts[], adUrls: Set<string>, count = 2): PostFacts[] {
  const videos = posts.filter((p) => p.isVideo && p.videoUrl);
  return [...videos.filter((p) => adUrls.has(p.url)), ...videos.filter((p) => !adUrls.has(p.url))].slice(0, count);
}

export async function deepAudit(
  db: Db,
  creatorId: number,
  input: { posts: PostFacts[]; adUrls: Set<string>; brief?: string | null },
): Promise<DeepAudit | { skipped: string }> {
  const chosen = pickVideos(input.posts, input.adUrls);
  if (chosen.length === 0) return { skipped: "немає роликів" };
  const images: Buffer[] = [];
  const hookFrames: number[] = [];
  let audio: Buffer | null = null;
  for (const [i, p] of chosen.entries()) {
    const parts = await processVideo(p.videoUrl!, { at: [-1, 0.4, 0.75], audioSec: i === 0 && !p.audioUrl ? 60 : 0 });
    for (const [j, f] of parts.frames.entries()) {
      const ok = await validImage(f);
      if (!ok || images.length >= 6) continue;
      images.push(ok);
      if (j === 0) hookFrames.push(images.length);
    }
    if (i === 0) audio = parts.audio;
  }
  // Звук окремим файлом (Instagram його віддає) — менше качати.
  if (!audio && chosen[0].audioUrl) {
    const res = await fetch(chosen[0].audioUrl, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (res?.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 2000 && buf.length < 20 * 1024 * 1024) audio = buf;
    }
  }
  if (images.length < 2) {
    for (const p of chosen) {
      const buf = p.cover ? await validImage(await download(p.cover)) : null;
      if (buf && images.length < 6) images.push(buf);
    }
  }
  if (images.length < 2) return { skipped: "не вдалося отримати кадри роликів" };

  const transcript = audio ? await transcribe(db, audio) : null;
  const collage = await buildCollage(images);
  await mkdir(path.dirname(deepCollagePath(creatorId)), { recursive: true });
  await writeFile(deepCollagePath(creatorId), collage);

  const captions = chosen.map((p, i) => `[video ${i + 1}${input.adUrls.has(p.url) ? ", sponsored" : ""}] ${p.caption.replace(/\s+/g, " ").slice(0, 400)}`).join("\n");
  const text = [
    input.brief?.trim() ? `Brief from the brand (trusted):\n${input.brief.trim().slice(0, 1200)}` : "There is no brief: set brief_fit.score to null.",
    transcript ? dataBlock("transcript", transcript.text) : "No transcript is available: delivery.score must be null.",
    dataBlock("captions", captions),
    `The collage has ${images.length} numbered frames.`,
  ].join("\n\n");
  const res = await chatJsonMeta(db, DeepReplySchema, [
    { role: "system", content: SYSTEM.replace("{HOOK}", hookFrames.join(", ") || "(none)") },
    { role: "user", content: [{ type: "text", text }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${collage.toString("base64")}` } }] },
  ], { purpose: "deep-audit", maxTokens: 900 });
  return groundDeep(res.data, { model: res.model, frames: images.length, videos: chosen.length, transcript, corpus: [transcript?.text ?? "", captions].join("\n") });
}

export function groundDeep(
  r: z.infer<typeof DeepReplySchema>,
  meta: { model: string; frames: number; videos: number; transcript: Transcript | null; corpus: string },
): DeepAudit {
  let dropped = 0;
  const quoteOk = (q: string) => (q.trim() && quoteFound(q, meta.corpus) ? q.trim().slice(0, 200) : null);
  const claim = (c: z.infer<typeof triFrames>): Claim => {
    const frames = validFrames(c.frames, meta.frames);
    const quote = quoteOk(c.quote);
    if (c.value === "yes" && frames.length === 0 && !quote) {
      dropped++;
      return { value: "unknown", frames: [], quote: null };
    }
    return { value: c.value, frames, quote };
  };
  const hookFrames = validFrames(r.hook.frames, meta.frames);
  const hookQuote = quoteOk(r.hook.quote);
  const hookOk = r.hook.score != null && (hookFrames.length > 0 || hookQuote);
  if (r.hook.score != null && !hookOk) dropped++;
  const speaks = claim(r.speaks_to_camera);
  const product = claim(r.product_in_use);
  const subtitles = claim(r.subtitles);
  const formats: ContentFormat[] = [];
  if (speaks.value === "yes") formats.push("talking_to_camera");
  if (product.value === "yes") formats.push("product_demo");
  if (meta.transcript && speaks.value === "no") formats.push("voiceover");
  if (subtitles.value === "yes") formats.push("subtitles");
  const fitFrames = validFrames(r.brief_fit.frames, meta.frames);
  return {
    version: DEEP_VERSION, model: meta.model, frames: meta.frames, videos: meta.videos, transcript: meta.transcript,
    hook: { score: hookOk ? r.hook.score : null, frames: hookFrames, quote: hookQuote, note: r.hook.note.slice(0, 200) },
    speaksToCamera: speaks, productInUse: product,
    benefitStated: claim(r.benefit_stated), callToAction: claim(r.call_to_action), subtitles,
    delivery: { score: meta.transcript ? r.delivery.score : null, note: r.delivery.note.slice(0, 200) },
    briefFit: r.brief_fit.score != null && fitFrames.length ? { score: r.brief_fit.score, reason: r.brief_fit.reason.slice(0, 300) } : null,
    formats, summary: r.summary.slice(0, 400), dropped,
  };
}

/** Якість рекламної подачі 0–100: зачіпка 25, товар у дії 20, користь 15, заклик 15, субтитри 10, подача 15. */
export function adQualityIndex(d: DeepAudit): number | null {
  const parts: [number, number | null][] = [
    [25, d.hook.score != null ? (d.hook.score - 1) / 4 : null],
    [20, d.productInUse.value === "unknown" ? null : d.productInUse.value === "yes" ? 1 : 0],
    [15, d.benefitStated.value === "unknown" ? null : d.benefitStated.value === "yes" ? 1 : 0],
    [15, d.callToAction.value === "unknown" ? null : d.callToAction.value === "yes" ? 1 : 0],
    [10, d.subtitles.value === "unknown" ? null : d.subtitles.value === "yes" ? 1 : 0],
    [15, d.delivery.score != null ? (d.delivery.score - 1) / 4 : null],
  ];
  const known = parts.filter(([, v]) => v != null) as [number, number][];
  if (known.length < 3) return null;
  const w = known.reduce((s, [k]) => s + k, 0);
  return Math.round((known.reduce((s, [k, v]) => s + k * v, 0) / w) * 100);
}
