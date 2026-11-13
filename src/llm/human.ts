/**
 * Тексти, що звучать як людина, а не як ІІ: правила для моделі, детектор типових «ІІ-ознак»
 * і детерміновані виправлення (довге тире, порожні ввічливі фрази), які не змінюють змісту.
 */

export const HUMAN_RULES = `Write like a real person typing a quick message, not like an assistant:
- Use contractions (I'm, I'll, you're, don't, it's). Plain everyday words. Mix short and longer sentences.
- No filler or stock phrases: never "I hope this message finds you well", "I'd be happy to", "Thank you for reaching out", "Great question", "Certainly", "Absolutely", "Please don't hesitate", "Feel free to reach out", "Rest assured", "I am excited to".
- No buzzwords: leverage, seamless, tailored, delve, elevate, robust, streamline, cutting-edge, game-changer, synergy, meticulous, furthermore, moreover, additionally, foster, resonate, unlock, empower, dive into, navigate, embark, esteemed, kindly.
- No em dashes. No semicolons. No headings or bold. Use a list only for 3+ separate items. At most one exclamation mark.
- Don't repeat the other person's words back to them, don't summarise at the end, don't over-explain.
- Sound like someone who does this work every day: specific, brief, a little informal, friendly.`;

/** Фрази й слова, за якими читач упізнає текст моделі. */
const TELLS: [RegExp, string][] = [
  [/\bI hope (this|my) (message|email|note) finds you well\b/i, "I hope this message finds you well"],
  [/\bI hope you('| a)re (doing )?well\b/i, "I hope you're doing well"],
  [/\bI'?d be (happy|glad|delighted|thrilled) to\b/i, "I'd be happy to"],
  [/\bI would be (happy|glad|delighted|thrilled) to\b/i, "I would be happy to"],
  [/\bthank you for reaching out\b/i, "thank you for reaching out"],
  [/\bgreat question\b/i, "great question"],
  [/(^|\n)\s*(certainly|absolutely)[!,.]/i, "certainly/absolutely"],
  [/\b(don'?t|do not) hesitate\b/i, "don't hesitate"],
  [/\bfeel free to\b/i, "feel free to"],
  [/\brest assured\b/i, "rest assured"],
  [/\bI('m| am) (so |really )?(excited|thrilled|passionate)\b/i, "I'm excited/passionate"],
  [/\b(delve|delving)\b/i, "delve"],
  [/\bleverag(e|ing)\b/i, "leverage"],
  [/\bseamless(ly)?\b/i, "seamless"],
  [/\btailored\b/i, "tailored"],
  [/\belevat(e|ing)\b/i, "elevate"],
  [/\brobust\b/i, "robust"],
  [/\bstreamlin(e|ing)\b/i, "streamline"],
  [/\bcutting[- ]edge\b/i, "cutting-edge"],
  [/\bgame[- ]changer\b/i, "game-changer"],
  [/\bsynerg(y|ies)\b/i, "synergy"],
  [/\bmeticulous(ly)?\b/i, "meticulous"],
  [/\b(furthermore|moreover)\b/i, "furthermore/moreover"],
  [/(^|[.!?]\s+)additionally,/i, "Additionally,"],
  [/\bfoster(ing)?\b/i, "foster"],
  [/\bresonat(e|es|ing) with\b/i, "resonate with"],
  [/\bunlock\b/i, "unlock"],
  [/\bempower(ing)?\b/i, "empower"],
  [/\bdive (into|deep)\b/i, "dive into"],
  [/\bembark\b/i, "embark"],
  [/\besteemed\b/i, "esteemed"],
  [/\bin today'?s (fast-paced|digital)\b/i, "in today's fast-paced"],
  [/\bI understand (your|that)\b/i, "I understand your/that"],
  [/—/, "довге тире —"],
  [/;/, "крапка з комою"],
  [/\*\*|^#+\s/m, "розмітка (жирний, заголовки)"],
];

/** Знайдені ІІ-ознаки (для англійського тексту — усі; для інших мов — лише розмітка й тире). */
export function aiTells(text: string, language = "en"): string[] {
  const list = language === "en" ? TELLS : TELLS.filter(([, name]) => /тире|розмітка/.test(name));
  const found = list.filter(([re]) => re.test(text)).map(([, name]) => name);
  if ((text.match(/!/g) ?? []).length > 1) found.push("кілька знаків оклику");
  return found;
}

export const tellIssues = (text: string, language = "en") => aiTells(text, language).map((t) => `звучить як ІІ: «${t}»`);
export const isTellIssue = (issue: string) => issue.startsWith("звучить як ІІ");

/**
 * Безпечні виправлення без зміни змісту: довге тире → кома/дефіс, «розумні» лапки → прості,
 * порожні ввічливі речення (finds you well, don't hesitate) — геть.
 */
export function humanize(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/(\S) — (\S)/g, "$1 - $2")
    .replace(/—/g, " - ")
    .replace(/[“”]/g, "\"").replace(/[‘’]/g, "'")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|\n)[^\S\n]*(I hope (this|my) (message|email|note) finds you well|I hope you('| a)re (doing )?well|I trust (this|my) (message|email) finds you well)[.!]?[^\S\n]*/gi, "$1")
    .replace(/[^\S\n]*(Please )?(don'?t|do not) hesitate to (reach out|contact me|ask|let me know)[^.!?\n]*[.!?]/gi, "")
    .replace(/[^\S\n]*Feel free to reach out[^.!?\n]*[.!?]/gi, "")
    .replace(/[^\S\n]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Ваші зразки повідомлень і відгуки, на які відповіли: модель підлаштовує тон, але не бере з них фактів. */
export function styleBlock(samples: string[]): string {
  const s = samples.map((x) => x.trim()).filter(Boolean).slice(0, 4);
  if (!s.length) return "";
  return `\nSTYLE SAMPLES (real messages by the same person; match their tone, length, simplicity and quirks; NEVER copy facts, numbers or names from them):\n${s.map((x, i) => `--- sample ${i + 1}\n${x.slice(0, 1200)}`).join("\n")}\n`;
}

/** Схоже на номер телефону: група цифр (з пробілами, дужками, дефісами), де самих цифр не менше 9. */
export function looksLikePhone(text: string): boolean {
  return (text.match(/\+?\d[\d\s().-]{7,}\d/g) ?? []).some((m) => m.replace(/\D/g, "").length >= 9 && !/\d{4}-\d{2}-\d{2}/.test(m));
}
