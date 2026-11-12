import type { ContentFormat, CriterionMode, IndexWeights, Search, SearchCriteria } from "@/db/schema";
import type { Risk } from "@/analysis/trust";

/**
 * Гнучкі критерії пошуку. Кожен — в одному з трьох положень:
 *   required — не виконано → автора відхилено (якщо дані невідомі — проходить з позначкою);
 *   preferred — виконано → вище в рейтингу (індекс «Відповідність»);
 *   off — не враховується.
 */

export const DEFAULT_CRITERIA: SearchCriteria = {
  followers: "required",
  country: "required",
  language: "required",
  activity: { mode: "required", days: 30 },
  er: { mode: "off", minPct: 1 },
  email: "preferred",
  ads: "off",
  trust: { mode: "required", maxRisk: "medium" },
  formats: { mode: "off", list: [] },
  quality: { min: 40, lead: 70 },
};
export const DEFAULT_WEIGHTS: IndexWeights = { fit: 1, quality: 1, readiness: 1, trust: 1, match: 1 };

export const FORMAT_LABELS: Record<ContentFormat, string> = {
  talking_to_camera: "говорить у камеру",
  product_demo: "показує товар у дії",
  voiceover: "закадровий голос",
  subtitles: "субтитри",
};
export const MODE_LABELS: Record<CriterionMode, string> = { required: "обов’язково", preferred: "бажано", off: "не важливо" };

export function criteriaOf(s: Pick<Search, "criteria">): SearchCriteria {
  const c = s.criteria ?? {};
  return {
    ...DEFAULT_CRITERIA,
    ...c,
    activity: { ...DEFAULT_CRITERIA.activity, ...c.activity },
    er: { ...DEFAULT_CRITERIA.er, ...c.er },
    trust: { ...DEFAULT_CRITERIA.trust, ...c.trust },
    formats: { ...DEFAULT_CRITERIA.formats, ...c.formats },
    quality: { ...DEFAULT_CRITERIA.quality, ...c.quality },
  };
}
export const weightsOf = (s: Pick<Search, "weights">): IndexWeights => ({ ...DEFAULT_WEIGHTS, ...s.weights });

export type CreatorFacts = {
  followers: number | null;
  country: string | null;
  language: string | null;
  daysSincePost: number | null;
  erLikes: number | null;
  /** null — контакти ще не шукали. */
  hasEmail: boolean | null;
  adPosts: number | null;
  postsSeen: number;
  trustRisk: Risk | null;
  /** null — глибокого аудиту ще не було. */
  formats: ContentFormat[] | null;
};

type Check = { mode: CriterionMode; status: "pass" | "fail" | "unknown"; fail: string; unknown: string };

export type CriteriaResult = { reject: string[]; notes: string[]; match: number | null; preferredMet: string[] };

const RISK_ORDER: Record<string, number> = { low: 0, medium: 1, high: 2 };

export function evaluateCriteria(
  c: SearchCriteria,
  s: Pick<Search, "minFollowers" | "maxFollowers" | "countries" | "languages">,
  f: CreatorFacts,
): CriteriaResult {
  const checks: (Check & { label: string })[] = [];
  const add = (mode: CriterionMode, label: string, status: Check["status"], fail: string, unknown: string) => {
    if (mode !== "off") checks.push({ mode, label, status, fail, unknown });
  };

  if (s.minFollowers != null || s.maxFollowers != null) {
    const v = f.followers;
    const low = v != null && s.minFollowers != null && v < s.minFollowers;
    const high = v != null && s.maxFollowers != null && v > s.maxFollowers;
    add(c.followers, "аудиторія", v == null ? "unknown" : low || high ? "fail" : "pass",
      low ? `замало підписників (${v})` : `забагато підписників (${v})`, "кількість підписників невідома");
  }
  if (s.countries.length) {
    add(c.country, "країна", !f.country ? "unknown" : s.countries.includes(f.country) ? "pass" : "fail", `інша країна (${f.country})`, "країну не визначено");
  }
  if (s.languages.length) {
    add(c.language, "мова", !f.language ? "unknown" : s.languages.includes(f.language) ? "pass" : "fail", `інша мова (${f.language})`, "мову не визначено");
  }
  add(c.activity.mode, "активність", f.daysSincePost == null ? "unknown" : f.daysSincePost <= c.activity.days ? "pass" : "fail",
    `не публікує понад ${c.activity.days} днів`, "дата останнього допису невідома");
  add(c.er.mode, "залученість", f.erLikes == null ? "unknown" : f.erLikes * 100 >= c.er.minPct ? "pass" : "fail",
    `залученість ${f.erLikes != null ? (f.erLikes * 100).toFixed(2) : "?"}% нижча за ${c.er.minPct}%`, "залученість невідома");
  add(c.email, "email", f.hasEmail == null ? "unknown" : f.hasEmail ? "pass" : "fail", "немає придатного email", "контакти ще не шукали");
  add(c.ads, "досвід реклами", f.adPosts == null ? "unknown" : f.adPosts > 0 ? "pass" : f.postsSeen >= 6 ? "fail" : "unknown",
    "реклами в останніх дописах немає", "замало дописів, щоб судити про рекламу");
  add(c.trust.mode, "довіра до аудиторії",
    !f.trustRisk || f.trustRisk === "unknown" ? "unknown" : RISK_ORDER[f.trustRisk] <= RISK_ORDER[c.trust.maxRisk] ? "pass" : "fail",
    `ризик накрутки: ${f.trustRisk === "high" ? "високий" : "середній"}`, "довіру до аудиторії не оцінено");
  if (c.formats.list.length) {
    const ok = f.formats?.some((x) => c.formats.list.includes(x));
    add(c.formats.mode, "формат", f.formats == null ? "unknown" : ok ? "pass" : "fail",
      `формат не той (потрібно: ${c.formats.list.map((x) => FORMAT_LABELS[x]).join(" або ")})`, "формат роликів не перевірено");
  }

  const reject = checks.filter((k) => k.mode === "required" && k.status === "fail").map((k) => k.fail);
  const notes = checks.filter((k) => k.mode === "required" && k.status === "unknown").map((k) => k.unknown);
  const preferred = checks.filter((k) => k.mode === "preferred" && k.status !== "unknown");
  const met = preferred.filter((k) => k.status === "pass");
  return {
    reject, notes,
    match: preferred.length ? Math.round((met.length / preferred.length) * 100) : null,
    preferredMet: met.map((k) => k.label),
  };
}

/** Загальна оцінка — зважене середнє наявних індексів (відсутні не тягнуть униз). */
export function weightedScore(w: IndexWeights, idx: Partial<Record<keyof IndexWeights, number | null | undefined>>): number {
  let sum = 0;
  let total = 0;
  for (const k of Object.keys(w) as (keyof IndexWeights)[]) {
    const v = idx[k];
    if (typeof v !== "number" || w[k] <= 0) continue;
    sum += w[k] * v;
    total += w[k];
  }
  return total ? Math.round(sum / total) : 0;
}
