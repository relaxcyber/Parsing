import type { ClientPolicy } from "@/db/schema";

/** Правила клієнта за замовчуванням: бартер, усе спірне — людині. */
export const DEFAULT_POLICY: ClientPolicy = {
  brandName: "",
  website: "",
  product: "",
  offerType: "barter",
  productValueUsd: null,
  feeTargetUsd: null,
  feeMaxUsd: null,
  maxRounds: 2,
  aboveMax: "escalate",
  deliverables: "1 Reel or TikTok-style video (30–60 s) and 2 stories",
  deadlineDays: 14,
  usageRights: "",
  disclosure: "Mark the post as an ad: Instagram 'Paid partnership' label or #ad",
  mustTag: [],
  shipsTo: [],
  notes: "",
  faq: [],
  mode: "approve",
  followupDays: 4,
  senderName: "",
};

export function policyOf(p: Partial<ClientPolicy> | null | undefined): ClientPolicy {
  return { ...DEFAULT_POLICY, ...(p ?? {}), faq: p?.faq ?? [], mustTag: p?.mustTag ?? [], shipsTo: p?.shipsTo ?? [] };
}

/**
 * Приблизні курси до долара — лише щоб порівняти ставку зі стелею. Порівнюємо з запасом 5%:
 * ставку, що ледь проходить за курсом, вирішує людина, а не ІІ.
 */
const USD_RATE: Record<string, number> = { USD: 1, EUR: 1.08, GBP: 1.27, CAD: 0.73, AUD: 0.66, PLN: 0.25, UAH: 0.024, CHF: 1.13 };
const SYMBOL: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP", "₴": "UAH", "zł": "PLN" };

export function currencyCode(raw: string | null | undefined): string | null {
  if (!raw) return "USD";
  const s = raw.trim();
  if (SYMBOL[s]) return SYMBOL[s];
  const up = s.toUpperCase().replace(/[^A-Z]/g, "");
  if (up === "US" || up === "DOLLARS" || up === "DOLLAR") return "USD";
  if (up === "EURO" || up === "EUROS") return "EUR";
  if (up === "ZL" || up === "PLN") return "PLN";
  return USD_RATE[up] ? up : null;
}

/** Ставка в доларах (з запасом 5% на курс); null — валюта невідома, вирішує людина. */
export function toUsd(amount: number, currency: string | null | undefined): number | null {
  const code = currencyCode(currency);
  if (!code) return null;
  const usd = amount * USD_RATE[code];
  return code === "USD" ? usd : Math.round(usd * 1.05 * 100) / 100;
}

/** Опис пропозиції для першого листа — з полів правил, без вигадок. */
export function offerText(p: ClientPolicy): string {
  const parts: string[] = [];
  if (p.product) parts.push(`Product: ${p.product}`);
  if (p.offerType === "barter") parts.push("Collaboration: free product in exchange for content (gifting)");
  if (p.offerType === "paid") parts.push(p.feeTargetUsd ? `Paid collaboration, $${p.feeTargetUsd}` : "Paid collaboration (ask the creator for their rates)");
  if (p.offerType === "both") parts.push(p.feeTargetUsd ? `Free product plus a fee of $${p.feeTargetUsd}` : "Free product plus a fee (ask the creator for their rates)");
  if (p.deliverables) parts.push(`Deliverables: ${p.deliverables}`);
  return parts.join(". ");
}

/**
 * Правила у вигляді, який бачить модель, що відповідає на питання автора. Стелі оплати тут немає:
 * її не можна видати в листі, ставку вирішує код.
 */
export function policyForAnswers(p: ClientPolicy): Record<string, string> {
  const fields: Record<string, string> = {
    brand: p.brandName,
    website: p.website,
    product: p.product,
    collaboration_type: { barter: "gifting: free product for content, no fee", paid: "paid collaboration", both: "free product plus a fee" }[p.offerType],
    product_value_usd: p.productValueUsd != null ? String(p.productValueUsd) : "",
    deliverables: p.deliverables,
    deadline: p.deadlineDays ? `${p.deadlineDays} days after the product arrives` : "",
    usage_rights: p.usageRights,
    disclosure: p.disclosure,
    tags_to_include: p.mustTag.join(", "),
    ships_to: p.shipsTo.length ? p.shipsTo.join(", ") : "",
    other_rules: p.notes,
  };
  p.faq.forEach((f, i) => (fields[`faq_${i + 1}`] = `Q: ${f.q}\nA: ${f.a}`));
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v && v.trim()));
}
