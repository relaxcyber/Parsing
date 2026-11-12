import { isNotNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { creators } from "@/db/schema";
import { median, type PostMetrics } from "./posts";

/**
 * Довіра до аудиторії. Точний «відсоток ботів» із публічних даних порахувати чесно неможливо,
 * тому результат — рівень ризику з конкретними причинами, які можна перевірити очима.
 */

export type Risk = "low" | "medium" | "high" | "unknown";
export type TrustSignal = { level: "high" | "medium" | "info"; text: string };
export type Bucket = "<10k" | "10–50k" | "50–250k" | "250k–1M" | ">1M";
export type Norm = { bucket: Bucket; erLikes: number; source: "base" | "default"; n: number };
export type TrustReport = { risk: Risk; score: number | null; signals: TrustSignal[]; norm: Norm | null };

export function sizeBucket(followers: number): Bucket {
  return followers < 10_000 ? "<10k" : followers < 50_000 ? "10–50k" : followers < 250_000 ? "50–250k" : followers < 1_000_000 ? "250k–1M" : ">1M";
}

/** Орієнтовні норми залученості за вподобаннями для Instagram — поки у вашій базі замало авторів свого розміру. */
export const DEFAULT_NORMS: Record<Bucket, number> = { "<10k": 0.03, "10–50k": 0.02, "50–250k": 0.013, "250k–1M": 0.01, ">1M": 0.008 };
const MIN_BASE = 30;

export type Norms = Record<Bucket, Norm>;

/** Норми за вашою базою: медіана залученості авторів того ж розміру; де їх замало — орієнтовна норма. */
export async function loadNorms(db: Db): Promise<Norms> {
  const rows = await db.select({ f: creators.followers, er: creators.erLikes }).from(creators).where(isNotNull(creators.erLikes)).limit(20_000);
  const by = new Map<Bucket, number[]>();
  for (const r of rows) {
    if (r.f == null || r.er == null || r.f < 500) continue;
    const b = sizeBucket(r.f);
    by.set(b, [...(by.get(b) ?? []), r.er]);
  }
  return Object.fromEntries(
    (Object.keys(DEFAULT_NORMS) as Bucket[]).map((b) => {
      const xs = by.get(b) ?? [];
      return [b, xs.length >= MIN_BASE
        ? { bucket: b, erLikes: Math.round(median(xs)! * 10000) / 10000, source: "base" as const, n: xs.length }
        : { bucket: b, erLikes: DEFAULT_NORMS[b], source: "default" as const, n: xs.length }];
    }),
  ) as Norms;
}

export type Snapshot = { at: Date; followers: number | null; erLikes: number | null };
export type CommentSignals = { total: number; genericShare: number; repeatCommenterShare: number; foreignShare: number | null; botLike?: boolean };

const pct = (x: number) => `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`;

export function assessTrust(input: {
  followers: number | null;
  follows: number | null;
  metrics: PostMetrics;
  norms: Norms;
  snapshots?: Snapshot[];
  comments?: CommentSignals | null;
  now?: Date;
}): TrustReport {
  const { followers, follows, metrics: m } = input;
  const signals: TrustSignal[] = [];
  if (!followers || followers < 100) return { risk: "unknown", score: null, signals: [{ level: "info", text: "замала аудиторія для оцінки" }], norm: null };
  const norm = input.norms[sizeBucket(followers)];

  if (m.hiddenLikes) signals.push({ level: "info", text: "автор приховує кількість вподобань — залученість не перевірити" });
  else if (m.withLikes < 3 || m.erLikes == null) signals.push({ level: "info", text: "замало дописів із видимими вподобаннями" });
  else {
    const ratio = m.erLikes / norm.erLikes;
    const normText = `норма для ${norm.bucket} — ${pct(norm.erLikes)}${norm.source === "default" ? " (орієнтовно)" : ` (за ${norm.n} авторами вашої бази)`}`;
    if (ratio < 0.2) signals.push({ level: "high", text: `залученість ${pct(m.erLikes)} — у ${Math.round(1 / ratio)} разів нижча за норму; ${normText}` });
    else if (ratio < 0.4) signals.push({ level: "medium", text: `залученість ${pct(m.erLikes)} — помітно нижча за норму; ${normText}` });
    else if (ratio > 5 && followers >= 10_000) signals.push({ level: "medium", text: `залученість ${pct(m.erLikes)} — у ${Math.round(ratio)} разів вища за норму: можливі куплені вподобання; ${normText}` });
    else signals.push({ level: "info", text: `залученість ${pct(m.erLikes)}; ${normText}` });

    if (m.medianLikes != null && m.medianLikes >= 100 && m.commentsPerLike != null && m.commentsPerLike < 0.002) {
      signals.push({ level: "medium", text: `майже немає коментарів: 1 на ${Math.round(1 / Math.max(m.commentsPerLike, 0.0001))} вподобань` });
    }
    if (m.medianComments != null && m.medianComments >= 20 && m.commentsPerLike != null && m.commentsPerLike > 0.3) {
      signals.push({ level: "medium", text: "коментарів незвично багато відносно вподобань — розіграші або групи взаємних коментарів" });
    }
    if (m.likesCv != null && m.withLikes >= 6 && m.medianLikes != null && m.medianLikes >= 50 && m.likesCv < 0.1) {
      signals.push({ level: "medium", text: "вподобання майже однакові на всіх дописах — так виглядають куплені пакети" });
    }
  }

  if (follows != null && followers >= 1000 && follows > followers) {
    signals.push({ level: "medium", text: `підписок (${follows}) більше, ніж підписників — ознака взаємних підписок` });
  }

  // Знімки: різкий приріст підписників без росту залученості — типова картина купівлі.
  const now = input.now ?? new Date();
  const past = (input.snapshots ?? [])
    .filter((s) => s.followers != null && now.getTime() - s.at.getTime() >= 7 * 86_400_000 && now.getTime() - s.at.getTime() <= 90 * 86_400_000)
    .sort((a, b) => a.at.getTime() - b.at.getTime())[0];
  if (past?.followers) {
    const growth = (followers - past.followers) / past.followers;
    const days = Math.round((now.getTime() - past.at.getTime()) / 86_400_000);
    const erDrop = past.erLikes && m.erLikes != null ? 1 - m.erLikes / past.erLikes : null;
    if (growth > 0.3 && followers - past.followers > 2000 && erDrop != null && erDrop > 0.4) {
      signals.push({ level: "high", text: `за ${days} дн. +${Math.round(growth * 100)}% підписників, а залученість упала на ${Math.round(erDrop * 100)}%` });
    } else if (growth > 0.3 && followers - past.followers > 2000) {
      signals.push({ level: "info", text: `за ${days} дн. +${Math.round(growth * 100)}% підписників` });
    }
  }

  const c = input.comments;
  if (c && c.total >= 15) {
    if (c.genericShare > 0.6) signals.push({ level: "medium", text: `${Math.round(c.genericShare * 100)}% коментарів — порожні («🔥», «nice»)` });
    if (c.repeatCommenterShare > 0.3) signals.push({ level: "medium", text: "одні й ті самі люди коментують різні дописи — схоже на групу взаємних коментарів" });
    if (c.foreignShare != null && c.foreignShare > 0.5) signals.push({ level: "medium", text: "більшість коментарів іншою мовою, ніж контент автора" });
    if (c.botLike) signals.push({ level: "medium", text: "модель побачила шаблонні коментарі, схожі на ботів (цитати в розборі коментарів)" });
  }

  const highs = signals.filter((s) => s.level === "high").length;
  const mediums = signals.filter((s) => s.level === "medium").length;
  const measurable = !m.hiddenLikes && m.withLikes >= 3;
  const risk: Risk = highs > 0 || mediums >= 3 ? "high" : mediums > 0 ? "medium" : measurable ? "low" : "unknown";
  const score = risk === "unknown" ? null : Math.max(0, 100 - highs * 40 - mediums * 15);
  return { risk, score, signals, norm };
}
