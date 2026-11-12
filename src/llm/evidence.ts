import { z } from "zod";

/**
 * Перевірка доказів: кожен висновок моделі має спиратися на дослівну цитату з даних, які їй дали.
 * Цитату, якої у даних немає, модель вигадала — такий висновок відкидаємо.
 */
export const normText = (s: string) =>
  s.normalize("NFKC").toLowerCase().replace(/[“”«»"'’‘`]/g, "").replace(/[^\p{L}\p{N}@#%$€£₴]+/gu, " ").replace(/\s+/g, " ").trim();

/** Цитата знайдена, якщо кожна її частина (модель може скорочувати через «…») є в корпусі. */
export function quoteFound(quote: string, corpus: string): boolean {
  const parts = quote.split(/…|\.\.\./).map(normText).filter((p) => p.length > 0);
  if (parts.length === 0 || parts.join("").length < 3) return false; // «NYC» — уже доказ, «ab» — ні
  const hay = ` ${normText(corpus)} `;
  return parts.every((p) => hay.includes(p));
}

export const verifiedQuotes = (quotes: string[] | undefined, corpus: string) =>
  [...new Set((quotes ?? []).filter((q) => typeof q === "string" && quoteFound(q, corpus)))].slice(0, 3);

export const Tri = z.enum(["yes", "no", "unknown"]);
export type TriValue = z.infer<typeof Tri>;

/** Висновок «так/ні/невідомо» з цитатами-доказами. */
export const triClaim = z.object({ value: Tri.catch("unknown"), evidence: z.array(z.string()).catch([]) }).catch({ value: "unknown", evidence: [] });
export type TriClaim = z.infer<typeof triClaim>;

/**
 * Висновок без підтвердженого доказу стає «невідомо». Повертає очищений висновок і ознаку,
 * що модель стверджувала щось без доказів (такі випадки рахуємо, щоб бачити, наскільки вона «фантазує»).
 */
export function groundTri(claim: TriClaim, corpus: string): TriClaim & { dropped: boolean } {
  const evidence = verifiedQuotes(claim.evidence, corpus);
  if (claim.value === "yes" && evidence.length === 0) return { value: "unknown", evidence: [], dropped: true };
  return { value: claim.value, evidence, dropped: false };
}

/** Номери кадрів мають бути серед показаних моделі (1..total). */
export const validFrames = (frames: unknown, total: number) =>
  [...new Set((Array.isArray(frames) ? frames : []).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= total))];
