import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { assertPublicUrl } from "@/collect/net";
import type { Db } from "@/db/client";
import { chatJsonMeta, GUARD, type ChatResult } from "@/llm/client";
import { validFrames } from "@/llm/evidence";

/**
 * Візуальний аудит. Замість вгадування «класу камери» модель оцінює те, що видно на кадрі, за
 * шкалою з описом кожного бала, і для кожної оцінки називає номери кадрів. Номери перевіряє код;
 * оцінка без кадрів не враховується, а Quality рахує код, а не модель.
 */
export const AUDIT_VERSION = "vision-v2";

const scoreField = z.object({
  score: z.number().int().min(1).max(5).nullable().catch(null),
  frames: z.array(z.number()).catch([]),
  note: z.string().catch(""),
}).catch({ score: null, frames: [], note: "" });

export const VisionReplySchema = z.object({
  frames: z.array(z.object({
    n: z.number().int(),
    face_visible: z.boolean().catch(false),
    product_visible: z.boolean().catch(false),
    text_on_screen: z.boolean().catch(false),
    setting: z.string().catch("other"),
  })).catch([]),
  sharpness: scoreField,
  lighting: scoreField,
  framing: scoreField,
  background: scoreField,
  minor_is_main_subject: z.object({ value: z.boolean().catch(false), frames: z.array(z.number()).catch([]) }).catch({ value: false, frames: [] }),
  brand_safety_flags: z.array(z.object({ flag: z.string(), frames: z.array(z.number()).catch([]) })).catch([]),
  aesthetic: z.string().catch(""),
  summary: z.string().catch(""),
});
export type VisionReply = z.infer<typeof VisionReplySchema>;

export type ScoreKey = "sharpness" | "lighting" | "framing" | "background";
export type VisionAudit = {
  version: string;
  model: string;
  frames: number;
  fromVideo: number;
  scores: Record<ScoreKey, { score: number | null; frames: number[]; note: string }>;
  faceShare: number;
  productShare: number;
  textShare: number;
  minor: boolean;
  flags: string[];
  aesthetic: string;
  summary: string;
  /** Скільки оцінок відкинуто, бо модель не назвала кадрів. */
  dropped: number;
};

const WEIGHTS: Record<ScoreKey, number> = { sharpness: 0.3, lighting: 0.3, framing: 0.15, background: 0.25 };

/**
 * Quality 0–100: різкість 30%, світло 30%, кадр 15%, фон 25% (бали 1–5 → 0–100), і 10% — частка кадрів,
 * де видно обличчя, товар чи текст на екрані (ознаки рекламної подачі). null — замало підтверджених оцінок.
 */
export function qualityIndex(a: Pick<VisionAudit, "scores" | "faceShare" | "productShare" | "textShare">): number | null {
  const have = (Object.keys(WEIGHTS) as ScoreKey[]).filter((k) => a.scores[k].score != null);
  if (have.length < 2) return null;
  const w = have.reduce((s, k) => s + WEIGHTS[k], 0);
  const base = have.reduce((s, k) => s + WEIGHTS[k] * ((a.scores[k].score! - 1) / 4) * 100, 0) / w;
  const dr = ((a.faceShare + a.productShare + a.textShare) / 3) * 100;
  return Math.round(base * 0.9 + dr * 0.1);
}

export function groundVision(r: VisionReply, total: number, meta: { model: string; fromVideo: number }): VisionAudit {
  let dropped = 0;
  const scores = Object.fromEntries((Object.keys(WEIGHTS) as ScoreKey[]).map((k) => {
    const frames = validFrames(r[k].frames, total);
    if (r[k].score != null && frames.length === 0) dropped++;
    return [k, { score: frames.length ? r[k].score : null, frames, note: r[k].note.slice(0, 160) }];
  })) as VisionAudit["scores"];
  const seen = r.frames.filter((f) => f.n >= 1 && f.n <= total);
  const shareOf = (key: "face_visible" | "product_visible" | "text_on_screen") => (seen.length ? seen.filter((f) => f[key]).length / seen.length : 0);
  const minorFrames = validFrames(r.minor_is_main_subject.frames, total);
  return {
    version: AUDIT_VERSION, model: meta.model, frames: total, fromVideo: meta.fromVideo, scores,
    faceShare: Math.round(shareOf("face_visible") * 100) / 100,
    productShare: Math.round(shareOf("product_visible") * 100) / 100,
    textShare: Math.round(shareOf("text_on_screen") * 100) / 100,
    // Діти як головні герої — лише якщо модель назвала щонайменше половину кадрів.
    minor: r.minor_is_main_subject.value && minorFrames.length >= Math.max(1, Math.ceil(total / 2)),
    flags: r.brand_safety_flags.filter((f) => validFrames(f.frames, total).length > 0).map((f) => f.flag.slice(0, 40)),
    aesthetic: r.aesthetic.slice(0, 60),
    summary: r.summary.slice(0, 300),
    dropped,
  };
}

export const VISION_PROMPT = `You are a strict art director screening UGC creators for paid product ads.
You see a collage of numbered frames (numbers in the corner; numbered left to right, top to bottom) from one creator's recent posts.
Judge only what is visible. ${GUARD}
Score each criterion from 1 to 5 using these anchors, and list the frame numbers that show it (an empty list means you could not judge it — then use null):
- sharpness: 1 blurry, pixelated or heavy compression; 3 ordinary phone quality; 5 crisp, fine texture of skin or product visible.
- lighting: 1 dark, noisy or blown out; 3 ordinary room light, some shadows; 5 soft, even, flattering light.
- framing: 1 subject cut off, tilted or random; 3 centred but plain; 5 deliberate composition, subject and product clearly placed.
- background: 1 cluttered, dirty or distracting; 3 ordinary home; 5 clean, intentional set that suits an ad.
Most amateur content scores 2-3. Do not reward filters or heavy editing.
Return ONLY JSON:
{
 "frames": [{"n": 1, "face_visible": bool, "product_visible": bool, "text_on_screen": bool, "setting": "home"|"studio"|"outdoor"|"store"|"car"|"other"}],
 "sharpness": {"score": 1-5 or null, "frames": [numbers], "note": "what you saw"},
 "lighting": {...same...}, "framing": {...same...}, "background": {...same...},
 "minor_is_main_subject": {"value": bool, "frames": [numbers]},   // a child under about 16 is the main subject
 "brand_safety_flags": [{"flag": "alcohol"|"nudity"|"violence"|"dangerous"|"hate"|"other", "frames": [numbers]}],
 "aesthetic": "2-4 words naming the visual style",
 "summary": "one sentence a marketer can read, naming concrete strengths or weaknesses"
}`;

const TILE = 512;

export async function download(url: string): Promise<Buffer | null> {
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

const label = (n: number) =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="26" fill="#000" fill-opacity="0.78"/>` +
    `<text x="32" y="43" font-size="30" font-family="DejaVu Sans, Arial, sans-serif" font-weight="bold" fill="#fff" text-anchor="middle">${n}</text></svg>`);

/** Колаж із пронумерованих кадрів (2×2 до чотирьох, 3×2 до шести): номер у кутку — щоб модель могла на нього послатися. */
export async function buildCollage(images: Buffer[]): Promise<Buffer> {
  const list = images.slice(0, 6);
  const cols = list.length > 4 ? 3 : 2;
  const rows = Math.ceil(list.length / cols);
  const tiles = await Promise.all(list.map((b) => sharp(b).resize(TILE, TILE, { fit: "cover", position: "attention" }).jpeg({ quality: 82 }).toBuffer()));
  const parts = tiles.flatMap((input, i) => {
    const left = (i % cols) * TILE;
    const top = Math.floor(i / cols) * TILE;
    return [{ input, left, top }, { input: label(i + 1), left: left + 8, top: top + 8 }];
  });
  return sharp({ create: { width: TILE * cols, height: TILE * rows, channels: 3, background: "#111111" } })
    .composite(parts).jpeg({ quality: 80 }).toBuffer();
}

export const collagePath = (creatorId: number) => path.join(process.cwd(), "data", "collages", `${creatorId}.jpg`);
export const deepCollagePath = (creatorId: number) => path.join(process.cwd(), "data", "collages", `${creatorId}-deep.jpg`);

export async function validImage(buf: Buffer | null): Promise<Buffer | null> {
  if (!buf) return null;
  try {
    await sharp(buf).metadata(); // відсіюємо биті файли до складання колажу
    return buf;
  } catch {
    return null;
  }
}

export type AuditResult = { audit: VisionAudit; quality: number | null; provider: string } | { skipped: string };
export type AuditMedia = { covers: string[]; videos?: string[] };

/** Запит до моделі за готовим колажем. examples — ваші минулі рішення, щоб модель знала вашу планку. */
export async function scoreCollage(
  db: Db,
  collage: Buffer,
  total: number,
  opts: { fromVideo?: number; examples?: string; exclude?: string[] } = {},
): Promise<{ audit: VisionAudit; quality: number | null; provider: string }> {
  const what = opts.fromVideo ? `${opts.fromVideo} frame(s) from inside the creator's videos and ${total - opts.fromVideo} post cover(s)` : `${total} post cover(s)`;
  const res: ChatResult<VisionReply> = await chatJsonMeta(db, VisionReplySchema, [
    { role: "system", content: VISION_PROMPT },
    { role: "user", content: [
      { type: "text", text: `The collage has ${total} numbered frames: ${what}.${opts.examples ? `\n\n${opts.examples}` : ""}` },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${collage.toString("base64")}` } },
    ] },
  ], { purpose: opts.exclude?.length ? "vision-second-opinion" : "vision-audit", maxTokens: 900, exclude: opts.exclude });
  const audit = groundVision(res.data, total, { model: res.model, fromVideo: opts.fromVideo ?? 0 });
  return { audit, quality: qualityIndex(audit), provider: res.provider };
}

/**
 * Швидкий аудит: до чотирьох обкладинок дописів (якщо відео недоступне чи не потрібне) або кадри з роликів.
 * Колаж зберігається для вітрини й для переоцінки новою версією промпту.
 */
export async function auditCreator(db: Db, creatorId: number, media: AuditMedia, opts: { examples?: string; videoFrames?: (url: string) => Promise<Buffer[]> } = {}): Promise<AuditResult> {
  const images: Buffer[] = [];
  let fromVideo = 0;
  if (opts.videoFrames) {
    for (const video of (media.videos ?? []).slice(0, 2)) {
      for (const f of await opts.videoFrames(video)) {
        const ok = await validImage(f);
        if (ok && images.length < 3) {
          images.push(ok);
          fromVideo++;
        }
      }
      if (fromVideo >= 3) break;
    }
  }
  for (const url of media.covers.slice(0, 8)) {
    if (images.length >= 4) break;
    const buf = await validImage(await download(url));
    if (buf) images.push(buf);
  }
  if (images.length < 2) return { skipped: images.length ? "замало зображень для оцінки" : "не вдалося завантажити зображення дописів" };

  const collage = await buildCollage(images);
  await mkdir(path.dirname(collagePath(creatorId)), { recursive: true });
  await writeFile(collagePath(creatorId), collage);
  return scoreCollage(db, collage, images.length, { fromVideo, examples: opts.examples });
}

/** Старі аудити (до vision-v2) мали інший формат — для показу зводимо обидва до спільного вигляду. */
export function auditView(a: Record<string, unknown> | null): { aesthetic?: string; summary?: string; minor: boolean; flags: string[]; scores?: VisionAudit["scores"] } | null {
  if (!a) return null;
  const v1Flags = Array.isArray(a.brand_safety_flags) ? (a.brand_safety_flags as unknown[]).filter((x): x is string => typeof x === "string") : [];
  return {
    aesthetic: typeof a.aesthetic === "string" ? a.aesthetic : undefined,
    summary: typeof a.summary === "string" ? a.summary : undefined,
    minor: a.minor === true || a.minor_is_main_subject === true,
    flags: Array.isArray(a.flags) ? (a.flags as string[]) : v1Flags,
    scores: a.scores as VisionAudit["scores"] | undefined,
  };
}
