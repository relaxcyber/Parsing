/**
 * Безкоштовна текстова оцінка кандидата — до будь-яких платних запитів.
 * Три вектори (0–10): Fit — відповідність ніші, Readiness — готовність до комерційної
 * співпраці, Quality — якість візуалу (її дає лише візуальний аудит, тут не рахується).
 */

export type Signal = { pattern: RegExp; weight: number; reason: string };

const READINESS: Signal[] = [
  { pattern: /\bugc\s*(creator|content|maker|video)/i, weight: 4, reason: "називає себе UGC-креатором" },
  { pattern: /\b(#?ugc\w*)\b/i, weight: 2, reason: "згадує UGC" },
  { pattern: /\bcontent\s+creator\b|контент[- ]?мейкер|контент[- ]?креатор/i, weight: 2, reason: "контент-креатор" },
  { pattern: /\bcollab(s|oration|orations)?\b|співпрац|сотрудничеств/i, weight: 2, reason: "відкритий до співпраці" },
  { pattern: /\b(work with me|open (for|to) (work|collabs?|brands?)|available for|dm (for|me)|pr friendly|brand (deals?|partner(ship)?s?))\b/i, weight: 2, reason: "запрошує бренди" },
  { pattern: /\b(portfolio|media ?kit|rate ?card)\b|портфоліо|портфолио/i, weight: 2, reason: "є портфоліо або медіакіт" },
  { pattern: /\b(unboxing|product review|honest review|testimonial|grwm)\b|розпаков|распаков/i, weight: 1, reason: "знімає огляди й розпаковки" },
  { pattern: /\b(ambassador|affiliate|discount code|use (my )?code)\b/i, weight: 1, reason: "має досвід партнерок" },
];

/** Ознаки магазину, агенції чи розіграшу — це не окремий автор. */
const NEGATIVE: Signal[] = [
  { pattern: /\b(giveaway|sweepstake)\b|розіграш|розыгрыш/i, weight: 2, reason: "розіграш" },
  { pattern: /\b(shop now|order now|free shipping|wholesale|we ship|in stock|dm to order)\b|доставка по/i, weight: 3, reason: "схоже на магазин" },
  { pattern: /\b(agency|we (are|help|create)|our (team|clients|services))\b|агенці|агентств/i, weight: 3, reason: "схоже на агенцію" },
];

const LINK_HUBS = /(beacons\.ai|stan\.store|linktr\.ee|canva\.(com|site)|carrd\.co|bio\.site|taplink\.cc|msha\.ke|hoo\.be|komi\.io|later\.com)/i;
const EMAIL = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;

export function extractEmails(text: string | null | undefined): string[] {
  if (!text) return [];
  const found = text.match(EMAIL) ?? [];
  return [...new Set(found.map((e) => e.toLowerCase().replace(/\.+$/, "")))].filter((e) => !/\.(png|jpe?g|gif|webp)$/.test(e));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Слово ніші як окреме слово або хештег; для кирилиці \b не працює, тому межі задаємо самі. */
const wordRe = (word: string) => new RegExp(`(?<![\\p{L}\\p{N}])#?${escapeRe(word.trim())}`, "iu");

export type ScoreInput = {
  /** Підписи дописів і хештеги. */
  texts: string[];
  bio?: string | null;
  links?: string[];
  keywords: string[];
  stopWords: string[];
  /** Хештеги самого пошуку: вони є в кожному знайденому дописі, тому сигналом не вважаються. */
  ignoreTags?: string[];
};

export type Score = {
  fit: number | null; readiness: number; score: number; reasons: string[];
  /** Спрацювало стоп-слово користувача. */
  blocked: boolean;
  /** Є ознаки магазину, агенції чи розіграшу. */
  negative: boolean;
};

const round1 = (n: number) => Math.round(n * 10) / 10;

export function scoreCandidate(input: ScoreInput): Score {
  let corpus = [input.bio ?? "", ...input.texts].join("\n");
  for (const tag of input.ignoreTags ?? []) corpus = corpus.replace(new RegExp(`#${escapeRe(tag)}(?![\\p{L}\\p{N}_])`, "giu"), " ");
  const reasons: string[] = [];

  let readiness = 0;
  for (const s of READINESS) {
    if (s.pattern.test(corpus)) {
      readiness += s.weight;
      reasons.push(s.reason);
    }
  }
  if (extractEmails(input.bio).length) {
    readiness += 2;
    reasons.push("вказав email");
  }
  if (input.links?.some((l) => LINK_HUBS.test(l))) {
    readiness += 2;
    reasons.push("є сторінка з посиланнями");
  }

  let penalty = 0;
  for (const s of NEGATIVE) {
    if (s.pattern.test(corpus)) {
      penalty += s.weight;
      reasons.push(`мінус: ${s.reason}`);
    }
  }
  const stops = input.stopWords.filter((w) => w.trim() && wordRe(w).test(corpus));
  if (stops.length) reasons.push(`стоп-слова: ${stops.join(", ")}`);

  const keywords = input.keywords.map((k) => k.trim()).filter(Boolean);
  const matched = keywords.filter((k) => wordRe(k).test(corpus));
  // Один збіг із кількох — уже помітна відповідність; далі росте повільніше.
  const fit = keywords.length ? round1(Math.min(10, (10 * Math.sqrt(matched.length)) / Math.sqrt(Math.min(keywords.length, 4)))) : null;
  if (matched.length) reasons.push(`ніша: ${matched.join(", ")}`);

  readiness = Math.max(0, Math.min(10, readiness - penalty));
  const score = round1(fit == null ? readiness : fit * 0.5 + readiness * 0.5);
  return { fit, readiness: round1(readiness), score, reasons, blocked: stops.length > 0, negative: penalty > 0 };
}
