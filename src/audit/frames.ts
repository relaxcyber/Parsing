import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertPublicUrl } from "@/collect/net";

const MAX_VIDEO_BYTES = 40 * 1024 * 1024;

/** Шлях до ffmpeg із пакета ffmpeg-static; null, якщо його немає (тоді аудит іде за обкладинками). */
async function ffmpegPath(): Promise<string | null> {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    const mod: any = await import("ffmpeg-static");
    return (mod.default ?? mod) || null;
  } catch {
    return null;
  }
}

const run = (bin: string, args: string[]) =>
  new Promise<{ ok: boolean; stderr: string }>((resolve) => {
    execFile(bin, args, { timeout: 60_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (err, _out, stderr) => resolve({ ok: !err, stderr: String(stderr) }));
  });

/**
 * Кадри з тіла ролика (а не обкладинка): обкладинку легко зробити гарною при слабкому відео.
 * Беремо кадри на 25%, 50% і 75% тривалості. Повертає [] при будь-якій невдачі.
 */
export async function extractFrames(videoUrl: string, count = 3): Promise<Buffer[]> {
  const ffmpeg = await ffmpegPath();
  if (!ffmpeg) return [];
  let dir: string | undefined;
  try {
    await assertPublicUrl(videoUrl);
    const res = await fetch(videoUrl, { signal: AbortSignal.timeout(60_000), headers: { "user-agent": "Mozilla/5.0" } });
    if (!res.ok || Number(res.headers.get("content-length")) > MAX_VIDEO_BYTES) return [];
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length < 10_000 || bytes.length > MAX_VIDEO_BYTES) return [];

    dir = await mkdtemp(path.join(os.tmpdir(), "frames-"));
    const file = path.join(dir, "video.mp4");
    await writeFile(file, bytes);
    // Тривалість читаємо з повідомлення ffmpeg — окремий ffprobe не потрібен.
    const probe = await run(ffmpeg, ["-hide_banner", "-i", file]);
    const m = probe.stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    const duration = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
    if (!(duration > 0.5)) return [];

    const frames: Buffer[] = [];
    for (let i = 1; i <= count; i++) {
      const out = path.join(dir, `f${i}.jpg`);
      const at = ((duration * i) / (count + 1)).toFixed(2);
      const r = await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-ss", at, "-i", file, "-frames:v", "1", "-q:v", "3", "-y", out]);
      if (!r.ok) continue;
      const buf = await readFile(out).catch(() => null);
      if (buf && buf.length > 1000) frames.push(buf);
    }
    return frames;
  } catch {
    return [];
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
