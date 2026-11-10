import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { assertPublicUrl } from "@/collect/net";
import type { Db } from "@/db/client";
import { chatJson } from "@/llm/client";

/** Схема відповіді моделі — за специфікацією, плюс прапорець про дітей у кадрі (COPPA / GDPR-K). */
export const VisionAuditSchema = z.object({
  production_tier: z.enum(["CINEMA_MIRRORLESS", "FLAGSHIP_SMARTPHONE", "MIDRANGE_SMARTPHONE", "LOWEND_DEGRADED"]),
  production_confidence: z.number().min(0).max(1),
  lighting_quality: z.number().min(1).max(10),
  background_cleanliness: z.number().min(1).max(10),
  direct_response_signals: z.object({
    has_captions_subtitles: z.boolean(),
    clear_product_focus: z.boolean(),
    engaging_expression: z.boolean(),
  }),
  minor_is_main_subject: z.boolean().default(false),
  brand_safety_flags: z.array(z.string()).default([]),
  rejection_reasons: z.array(z.enum(["BAD_LIGHTING", "LOW_RESOLUTION", "MESSY_ENVIRONMENT", "NO_CREATOR_FACE", "BRAND_UNSAFE"])).default([]),
  aesthetic: z.string().max(60).default(""),
  summary: z.string().max(300).default(""),
});
export type VisionAudit = z.infer<typeof VisionAuditSchema>;

const TIER_BASE: Record<VisionAudit["production_tier"], number> = {
  CINEMA_MIRRORLESS: 95, FLAGSHIP_SMARTPHONE: 80, MIDRANGE_SMARTPHONE: 55, LOWEND_DEGRADED: 25,
};

/** Quality Index 0–100: клас зйомки (40%), світло (25%), фон (25%), ознаки рекламної подачі (10%). */
export function qualityIndex(a: VisionAudit): number {
  const dr = Object.values(a.direct_response_signals).filter(Boolean).length / 3;
  return Math.round(TIER_BASE[a.production_tier] * 0.4 + a.lighting_quality * 10 * 0.25 + a.background_cleanliness * 10 * 0.25 + dr * 100 * 0.1);
}

const PROMPT = `You are a strict art director screening UGC creators for paid product ads.
The image is a 2x2 collage of this creator's recent posts. Judge only what is visible.
Return ONLY a JSON object with exactly these keys:
- production_tier: "CINEMA_MIRRORLESS" | "FLAGSHIP_SMARTPHONE" | "MIDRANGE_SMARTPHONE" | "LOWEND_DEGRADED" (sharpness, noise, compression)
- production_confidence: 0..1
- lighting_quality: 1..10 (soft, even light scores high; dim, harsh or mixed light scores low)
- background_cleanliness: 1..10 (tidy, intentional setting scores high; clutter, dirty mirrors, mess score low)
- direct_response_signals: { has_captions_subtitles: boolean, clear_product_focus: boolean, engaging_expression: boolean }
- minor_is_main_subject: boolean (true if a child under about 16 is the main subject of most frames)
- brand_safety_flags: string[] (alcohol, nudity, violence, dangerous behaviour, hate; empty if none)
- rejection_reasons: array of "BAD_LIGHTING" | "LOW_RESOLUTION" | "MESSY_ENVIRONMENT" | "NO_CREATOR_FACE" | "BRAND_UNSAFE" (empty if acceptable)
- aesthetic: 2-4 words naming the visual style, e.g. "Clean Girl", "Tech Minimal", "Home Cooking"
- summary: one sentence a marketer can read, naming concrete strengths or weaknesses
Be critical: most amateur content deserves MIDRANGE_SMARTPHONE and scores of 4-6.`;

const TILE = 512;

async function download(url: string): Promise<Buffer | null> {
  try {
    await assertPublicUrl(url);
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { "user-agent": "Mozilla/5.0" } });
    if (!res.ok || !(res.headers.get("content-type") ?? "image/").startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 1000 && buf.length < 15 * 1024 * 1024 ? buf : null;
  } catch {
    return null;
  }
}

/** Колаж 2×2 з до чотирьох кадрів: одне зображення коштує моделі вчетверо менше, ніж чотири. */
export async function buildCollage(images: Buffer[]): Promise<Buffer> {
  const tiles = await Promise.all(
    images.slice(0, 4).map((b) => sharp(b).resize(TILE, TILE, { fit: "cover", position: "attention" }).jpeg({ quality: 82 }).toBuffer()),
  );
  return sharp({ create: { width: TILE * 2, height: TILE * 2, channels: 3, background: "#111111" } })
    .composite(tiles.map((input, i) => ({ input, left: (i % 2) * TILE, top: Math.floor(i / 2) * TILE })))
    .jpeg({ quality: 80 })
    .toBuffer();
}

export const collagePath = (creatorId: number) => path.join(process.cwd(), "data", "collages", `${creatorId}.jpg`);

export type AuditResult = { audit: VisionAudit; quality: number; frames: number } | { skipped: string };

/** Завантажує кадри, складає колаж, зберігає його для вітрини й отримує оцінку моделі. */
export async function auditCreator(db: Db, creatorId: number, imageUrls: string[]): Promise<AuditResult> {
  const images: Buffer[] = [];
  for (const url of imageUrls.slice(0, 8)) {
    if (images.length >= 4) break;
    const buf = await download(url);
    if (!buf) continue;
    try {
      await sharp(buf).metadata(); // відсіюємо биті файли до складання колажу
      images.push(buf);
    } catch {}
  }
  if (images.length < 2) return { skipped: images.length ? "замало зображень для оцінки" : "зображення недоступні (посилання застаріли)" };

  const collage = await buildCollage(images);
  await mkdir(path.dirname(collagePath(creatorId)), { recursive: true });
  await writeFile(collagePath(creatorId), collage);

  const audit = await chatJson(db, VisionAuditSchema, [
    { role: "user", content: [
      { type: "text", text: `${PROMPT}\nThe collage contains ${images.length} frame(s).` },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${collage.toString("base64")}` } },
    ] },
  ], { purpose: "vision-audit" });
  return { audit, quality: qualityIndex(audit), frames: images.length };
}
