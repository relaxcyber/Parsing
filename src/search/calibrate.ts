export type Labeled = { quality: number; verdict: "yes" | "no" };
export type Calibration = { labeled: number; current: { threshold: number; agree: number }; best: { threshold: number; agree: number } | null };

/**
 * Порівнює оцінку якості моделі з вашими вердиктами «взяв би / ні» і шукає поріг,
 * за якого вони збігаються найчастіше. Пораду даємо лише від 10 розмічених авторів обох типів.
 */
export function calibrate(rows: Labeled[], currentThreshold: number): Calibration {
  const agreeAt = (t: number) => rows.filter((r) => (r.quality >= t) === (r.verdict === "yes")).length;
  const current = { threshold: currentThreshold, agree: agreeAt(currentThreshold) };
  const both = rows.some((r) => r.verdict === "yes") && rows.some((r) => r.verdict === "no");
  if (rows.length < 10 || !both) return { labeled: rows.length, current, best: null };
  let best = current;
  for (let t = 30; t <= 90; t += 5) {
    const agree = agreeAt(t);
    // За рівного результату лишаємо поріг, ближчий до чинного.
    if (agree > best.agree || (agree === best.agree && Math.abs(t - currentThreshold) < Math.abs(best.threshold - currentThreshold))) best = { threshold: t, agree };
  }
  return { labeled: rows.length, current, best };
}
