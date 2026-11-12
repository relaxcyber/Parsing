import { readFile } from "node:fs/promises";
import { isNotNull } from "drizzle-orm";
import { AUDIT_VERSION, collagePath, scoreCollage } from "@/audit/vision";
import type { Db } from "@/db/client";
import { creators, evalRuns } from "@/db/schema";
import { LlmUnavailableError } from "@/llm/client";
import { DEFAULT_CRITERIA } from "./criteria";

/**
 * Перевірка промпту на ваших вердиктах («еталонний набір»): збережені колажі розмічених авторів
 * оцінюються поточною версією аудиту, і рахується, у скількох випадках модель погодилась із вами
 * (якість ≥ порога ліда ⇔ «взяв би»). Так видно, чи нова версія справді краща за стару.
 */
const g = globalThis as unknown as { __evalRunning?: boolean };
export const evalRunning = () => !!g.__evalRunning;

export async function runEval(db: Db, threshold = DEFAULT_CRITERIA.quality.lead): Promise<{ total: number; agree: number } | null> {
  if (g.__evalRunning) return null;
  g.__evalRunning = true;
  try {
    const rows = await db.select({ id: creators.id, verdict: creators.manualVerdict, audit: creators.audit }).from(creators).where(isNotNull(creators.manualVerdict));
    const results: { creatorId: number; verdict: "yes" | "no"; quality: number | null }[] = [];
    for (const r of rows) {
      const collage = await readFile(collagePath(r.id)).catch(() => null);
      if (!collage) continue;
      const frames = typeof (r.audit as { frames?: unknown } | null)?.frames === "number" ? ((r.audit as { frames: number }).frames) : 4;
      try {
        const res = await scoreCollage(db, collage, frames);
        results.push({ creatorId: r.id, verdict: r.verdict!, quality: res.quality });
      } catch (e) {
        if (e instanceof LlmUnavailableError) break;
        results.push({ creatorId: r.id, verdict: r.verdict!, quality: null });
      }
    }
    const scored = results.filter((x) => x.quality != null);
    const agree = scored.filter((x) => (x.quality! >= threshold) === (x.verdict === "yes")).length;
    if (results.length) await db.insert(evalRuns).values({ version: AUDIT_VERSION, total: scored.length, agree, threshold, results });
    return { total: scored.length, agree };
  } finally {
    g.__evalRunning = false;
  }
}
