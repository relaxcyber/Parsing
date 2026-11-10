/**
 * Оцінка кандидата за трьома незалежними індексами (0–100):
 *   Fit — наскільки автор підходить під запит: ніша + роль (UGC-креатор або афіліат);
 *   Readiness — готовність до співпраці прямо зараз: контакт, свіжість, прайс, портфоліо;
 *   Quality — якість візуалу, її дає лише візуальний аудит (src/audit/vision.ts).
 * Текстова частина безкоштовна й рахується до будь-яких платних запитів.
 */

export type Signal = { pattern: RegExp; weight: number; reason: string };

const UGC_ROLE: Signal[] = [
  { pattern: /\bugc\s*(creator|content|maker|video)/i, weight: 16, reason: "називає себе UGC-креатором" },
  { pattern: /\b(#?ugc\w*)\b/i, weight: 8, reason: "згадує UGC" },
  { pattern: /\bcontent\s+creator\b|контент[- ]?мейкер|контент[- ]?креатор/i, weight: 8, reason: "контент-креатор" },
  { pattern: /\bcollab(s|oration|orations)?\b|співпрац|сотрудничеств/i, weight: 8, reason: "відкритий до співпраці" },
  { pattern: /\b(work with me|open (for|to) (work|collabs?|brands?)|available for|dm (for|me)|pr friendly|brand (deals?|partner(ship)?s?))\b/i, weight: 8, reason: "запрошує бренди" },
  { pattern: /\b(portfolio|media ?kit|rate ?card)\b|портфоліо|портфолио/i, weight: 6, reason: "згадує портфоліо або медіакіт" },
  { pattern: /\b(unboxing|product review|honest review|testimonial|grwm)\b|розпаков|распаков/i, weight: 4, reason: "знімає огляди й розпаковки" },
];

const AFFILIATE_ROLE: Signal[] = [
  { pattern: /\b(amazon (finds|storefront|influencer|must[- ]haves?)|storefront|ltk|liketoknow|shopmy|tiktok shop)\b/i, weight: 14, reason: "веде партнерську вітрину" },
  { pattern: /\b(affiliate|commission(able)?|#ad\b|#affiliate|partner link)\b|партнерськ|партнерск/i, weight: 10, reason: "працює з партнерськими посиланнями" },
  { pattern: /\b(discount code|promo code|use (my )?code|code\s+[A-Z0-9]{3,}\b)/i, weight: 8, reason: "роздає промокоди" },
  { pattern: /\b(link in bio|shop my|shop the|links? below|linked in)\b/i, weight: 6, reason: "веде аудиторію за посиланнями" },
  { pattern: /\b(ambassador|brand partner)\b/i, weight: 6, reason: "амбасадор бренду" },
];

/** Ознаки магазину, агенції, платформи чи розіграшу — це не окремий автор. */
const NEGATIVE: Signal[] = [
  { pattern: /\b(giveaway|sweepstake)\b|розіграш|розыгрыш/i, weight: 10, reason: "розіграш" },
  { pattern: /\b(shop now|order now|free shipping|wholesale|we ship|in stock|dm to order)\b|доставка по/i, weight: 15, reason: "схоже на магазин" },
  { pattern: /\b(agency|we (are|help|create)|our (team|clients|services))\b|агенці|агентств/i, weight: 15, reason: "схоже на агенцію" },
  { pattern: /\b(marketplace|platform for|hire (ugc )?creators|verified (ugc )?creators|brands?\s*[×x&]\s*creators|for brands and creators|start free)\b/i, weight: 20, reason: "схоже на платформу-посередника" },
];

const EMAIL = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;

export function extractEmails(text: string | null | undefined): string[] {
  if (!text) return [];
  const found = text.match(EMAIL) ?? [];
  return [...new Set(found.map((e) => e.toLowerCase().replace(/\.+$/, "")))].filter((e) => !/\.(png|jpe?g|gif|webp)$/.test(e));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Слово ніші як окреме слово або хештег; для кирилиці \b не працює, тому межі задаємо самі. */
const wordRe = (word: string) => new RegExp(`(?<![\\p{L}\\p{N}])#?${escapeRe(word.trim())}`, "iu");

export type Focus = "ugc" | "affiliate";

export type ScoreInput = {
  /** Підписи дописів і хештеги. */
  texts: string[];
  bio?: string | null;
  keywords: string[];
  stopWords: string[];
  /** Хештеги самого пошуку: вони є в кожному знайденому дописі, тому сигналом не вважаються. */
  ignoreTags?: string[];
  focus?: Focus;
  /** Партнерські платформи, знайдені в посиланнях автора. */
  affiliate?: string[];
};

export type Score = {
  /** Fit Index 0–100. */
  fit: number;
  reasons: string[];
  /** Спрацювало стоп-слово користувача. */
  blocked: boolean;
  /** Є ознаки магазину, агенції, платформи чи розіграшу. */
  negative: boolean;
};

const ROLE_MAX = 40;
const NICHE_MAX = 60;

export function scoreCandidate(input: ScoreInput): Score {
  let corpus = [input.bio ?? "", ...input.texts].join("\n");
  for (const tag of input.ignoreTags ?? []) corpus = corpus.replace(new RegExp(`#${escapeRe(tag)}(?![\\p{L}\\p{N}_])`, "giu"), " ");
  const reasons: string[] = [];
  const focus = input.focus ?? "ugc";

  // Роль: у фокусі «афіліат» головні ознаки — вітрини й партнерські посилання, UGC — другорядні.
  let role = 0;
  const [primary, secondary] = focus === "affiliate" ? [AFFILIATE_ROLE, UGC_ROLE] : [UGC_ROLE, AFFILIATE_ROLE];
  for (const s of primary) {
    if (s.pattern.test(corpus)) {
      role += s.weight;
      reasons.push(s.reason);
    }
  }
  for (const s of secondary) if (s.pattern.test(corpus)) role += s.weight / 4;
  if (input.affiliate?.length) {
    role += focus === "affiliate" ? Math.min(30, input.affiliate.length * 15) : 4;
    reasons.push(`партнерки: ${input.affiliate.join(", ")}`);
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
  if (matched.length) reasons.push(`ніша: ${matched.join(", ")}`);
  role = Math.max(0, Math.min(ROLE_MAX, role - penalty));

  // Без слів ніші Fit — це лише роль, розтягнута на всю шкалу. Один збіг із кількох слів уже помітний.
  const fit = keywords.length
    ? Math.round(role + Math.min(NICHE_MAX, (NICHE_MAX * Math.sqrt(matched.length)) / Math.sqrt(Math.min(keywords.length, 4))))
    : Math.round((role / ROLE_MAX) * 100);
  return { fit, reasons, blocked: stops.length > 0, negative: penalty > 0 };
}

export type ReadinessInput = {
  /** Найкращий статус email: personal | business | role | unknown | немає. */
  emailStatus?: string | null;
  daysSincePost?: number | null;
  hasRate?: boolean;
  hasPortfolio?: boolean;
};

/** Readiness Index 0–100 за специфікацією: контакт 40, свіжість 30, прайс 20, портфоліо 10. */
export function readinessIndex(i: ReadinessInput): { readiness: number; reasons: string[] } {
  let readiness = 0;
  const reasons: string[] = [];
  if (i.emailStatus === "personal" || i.emailStatus === "business") {
    readiness += 40;
    reasons.push("є email");
  } else if (i.emailStatus === "role" || i.emailStatus === "unknown") {
    readiness += 20;
    reasons.push(i.emailStatus === "role" ? "лише загальна адреса" : "email не вдалося перевірити");
  }
  if (i.daysSincePost != null) {
    if (i.daysSincePost <= 7) {
      readiness += 30;
      reasons.push("публікував цього тижня");
    } else if (i.daysSincePost <= 14) {
      readiness += 15;
      reasons.push("публікував за останні 2 тижні");
    }
  }
  if (i.hasRate) {
    readiness += 20;
    reasons.push("є прайс");
  }
  if (i.hasPortfolio) {
    readiness += 10;
    reasons.push("є портфоліо");
  }
  return { readiness, reasons };
}

/** Загальна оцінка — середнє наявних індексів (Quality може бути відсутнім). */
export const overall = (...parts: (number | null | undefined)[]) => {
  const have = parts.filter((p): p is number => typeof p === "number");
  return have.length ? Math.round(have.reduce((a, b) => a + b, 0) / have.length) : 0;
};
