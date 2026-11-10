/**
 * Країна та мова автора за непрямими ознаками. Це оцінка, а не факт: прапорці в біо, назви
 * міст і країн, домен вітрини Amazon, валюта прайсу. Невизначене лишається невизначеним.
 */

const PLACES: Record<string, RegExp> = {
  US: /\b(usa|u\.s\.a?\.?|united states|america|nyc|new york|los angeles|california|texas|florida|chicago|miami|atlanta|seattle|boston|houston|dallas|denver|arizona|ohio|michigan|georgia|virginia|nashville|las vegas|san diego|san francisco|philadelphia)\b/i,
  GB: /\b(uk|u\.k\.|united kingdom|england|london|manchester|birmingham|scotland|wales|liverpool|leeds|glasgow|bristol|edinburgh)\b/i,
  CA: /\b(canada|toronto|vancouver|montreal|calgary|ottawa|ontario|alberta)\b/i,
  AU: /\b(australia|sydney|melbourne|brisbane|perth|adelaide)\b/i,
  DE: /\b(germany|deutschland|berlin|münchen|munich|hamburg|köln|cologne|frankfurt|stuttgart|düsseldorf)\b/i,
  FR: /\b(france|paris|lyon|marseille|toulouse|bordeaux)\b/i,
  ES: /\b(españa|spain|madrid|barcelona|valencia|sevilla)\b/i,
  IT: /\b(italia|italy|milano|milan|roma|rome|napoli|torino)\b/i,
  NL: /\b(netherlands|nederland|amsterdam|rotterdam|utrecht)\b/i,
  PL: /\b(poland|polska|warszawa|warsaw|kraków|krakow|wrocław)\b/i,
  UA: /\b(ukraine|україна|украина|київ|kyiv|kiev|львів|lviv|одеса|odesa|харків|kharkiv|дніпро)/i,
  IN: /\b(india|mumbai|delhi|bangalore|bengaluru|hyderabad|kolkata|chennai|pune|assam|kerala|gujarat|punjab|bengali)\b/i,
  BR: /\b(brasil|brazil|são paulo|sao paulo|rio de janeiro)\b/i,
  MX: /\b(méxico|mexico|cdmx|guadalajara|monterrey)\b/i,
  AE: /\b(uae|dubai|abu dhabi)\b/i,
  PH: /\b(philippines|manila|cebu)\b/i,
  ID: /\b(indonesia|jakarta|bali)\b/i,
  NG: /\b(nigeria|lagos|abuja)\b/i,
  ZA: /\b(south africa|johannesburg|cape town)\b/i,
};
const AMAZON_TLD: Record<string, string> = {
  "co.uk": "GB", de: "DE", fr: "FR", it: "IT", es: "ES", ca: "CA", "com.au": "AU", in: "IN", "com.mx": "MX", "com.br": "BR", nl: "NL", pl: "PL", ae: "AE",
};

export type Geo = { country: string | null; confidence: number; signals: string[] };

export function normalizeCountry(code: string): string {
  const c = code.trim().toUpperCase();
  return c === "UK" ? "GB" : c === "USA" ? "US" : c;
}

export function detectCountry(input: { bio?: string | null; links?: string[]; currencies?: string[] }): Geo {
  const scores = new Map<string, number>();
  const signals: string[] = [];
  const add = (country: string, weight: number, why: string) => {
    scores.set(country, (scores.get(country) ?? 0) + weight);
    signals.push(why);
  };
  const bio = input.bio ?? "";
  // Прапорець — це пара «регіональних індикаторів»; переводимо їх у код країни.
  for (const m of bio.matchAll(/([\u{1F1E6}-\u{1F1FF}])([\u{1F1E6}-\u{1F1FF}])/gu)) {
    const code = String.fromCharCode(m[1].codePointAt(0)! - 0x1f1e6 + 65, m[2].codePointAt(0)! - 0x1f1e6 + 65);
    add(code, 0.7, `прапорець ${code}`);
  }
  for (const [country, re] of Object.entries(PLACES)) {
    const m = bio.match(re);
    if (m) add(country, /📍/.test(bio) ? 0.6 : 0.5, `згадка «${m[0]}»`);
  }
  for (const link of input.links ?? []) {
    const m = link.match(/amazon\.([a-z.]+?)\/(?:shop|gp|dp|stores)/i);
    if (!m) continue;
    const tld = m[1].toLowerCase();
    if (AMAZON_TLD[tld]) add(AMAZON_TLD[tld], 0.5, `Amazon ${tld}`);
    else if (tld === "com") add("US", 0.3, "Amazon .com");
  }
  if (input.currencies?.includes("GBP")) add("GB", 0.4, "прайс у фунтах");
  if (scores.size === 0) return { country: null, confidence: 0, signals: [] };
  const [country, score] = [...scores.entries()].sort((a, b) => b[1] - a[1])[0];
  return { country, confidence: Math.round(Math.min(1, score) * 100) / 100, signals };
}

const STOPWORDS: Record<string, string[]> = {
  en: ["the", "and", "for", "with", "my", "you", "your", "this", "that", "is", "of", "to", "in", "on", "me", "our", "are", "it", "all"],
  es: ["el", "la", "los", "las", "de", "que", "y", "en", "para", "con", "mi", "tu", "por", "una", "un", "es", "del", "más"],
  pt: ["o", "os", "as", "de", "que", "e", "em", "para", "com", "meu", "minha", "você", "uma", "um", "não", "do", "da", "mais"],
  de: ["der", "die", "das", "und", "für", "mit", "mein", "meine", "ich", "ist", "nicht", "auf", "ein", "eine", "von", "zu", "bei"],
  fr: ["le", "la", "les", "de", "des", "et", "pour", "avec", "mon", "ma", "vous", "une", "un", "est", "du", "sur", "pas", "je"],
  it: ["il", "lo", "gli", "di", "che", "e", "per", "con", "mio", "mia", "una", "un", "non", "del", "della", "più", "sono"],
  pl: ["i", "w", "na", "z", "do", "się", "nie", "to", "jest", "dla", "mój", "moja", "jak", "ale", "że"],
  nl: ["de", "het", "een", "en", "van", "voor", "met", "mijn", "je", "is", "niet", "op", "aan", "bij"],
  tr: ["ve", "bir", "bu", "için", "ile", "çok", "ben", "sen", "de", "da", "mi", "ne"],
  id: ["yang", "dan", "di", "untuk", "dengan", "ini", "itu", "aku", "kamu", "tidak", "dari", "ke"],
};

/** Мова тексту: спершу за письмом (кирилиця, деванагарі…), для латиниці — за службовими словами. */
export function detectLanguage(text: string): { language: string | null; confidence: number } {
  const letters = text.replace(/https?:\/\/\S+|[@#]\S+/g, " ");
  const count = (re: RegExp) => (letters.match(re) ?? []).length;
  const total = count(/\p{L}/gu);
  if (total < 12) return { language: null, confidence: 0 };
  const cyr = count(/[Ѐ-ӿ]/g);
  if (cyr / total > 0.4) {
    const uk = count(/[іїєґ]/gi);
    const ru = count(/[ыэъё]/gi);
    return { language: uk > ru ? "uk" : "ru", confidence: uk === ru ? 0.5 : 0.9 };
  }
  for (const [lang, re] of [["hi", /[ऀ-ॿ]/g], ["ar", /[؀-ۿ]/g], ["zh", /[一-鿿]/g], ["ja", /[぀-ヿ]/g], ["ko", /[가-힯]/g], ["th", /[฀-๿]/g]] as const) {
    if (count(re) / total > 0.3) return { language: lang, confidence: 0.9 };
  }
  const words = letters.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < 6) return { language: null, confidence: 0 };
  const hits = Object.entries(STOPWORDS).map(([lang, list]) => [lang, words.filter((w) => list.includes(w)).length] as const).sort((a, b) => b[1] - a[1]);
  const [best, second] = hits;
  if (best[1] < 3 || best[1] === second[1]) return { language: null, confidence: 0 };
  return { language: best[0], confidence: Math.round(Math.min(1, (best[1] - second[1]) / Math.max(4, words.length * 0.15)) * 100) / 100 };
}
