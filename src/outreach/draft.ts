import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { DeepAudit } from "@/audit/deep";
import type { VisionAudit } from "@/audit/vision";
import type { AdsReport } from "@/analysis/ads";
import { profilePosts } from "@/analysis/posts";
import type { ProfileAnalysis } from "@/analysis/profile";
import type { Db } from "@/db/client";
import { contentItems, creators, outreachDrafts, searches, type Creator, type Search } from "@/db/schema";
import { detectLanguage } from "@/enrich/geo";
import { chatJsonMeta, dataBlock, GUARD } from "@/llm/client";

/**
 * Чернетки першого листа. Код складає «лист фактів» (ім’я, конкретний допис, перевірені спостереження,
 * умови з брифу), модель пише лише з нього, а перевірка після генерації шукає в тексті числа, посилання
 * й імена, яких у фактах немає. Не пройшло — модель переписує; знову ні — чернетка позначається.
 * Надсилаєте ви самі: застосунок листів не відправляє.
 */

export const DRAFT_VERSION = "draft-v2";
export const SENDER = "{{sender_name}}";

export type FactSheet = {
  creator: { handle: string; name: string | null; followers: number | null; niches: string[]; language: string | null };
  post: { url: string; caption: string; date: string | null } | null;
  observations: string[];
  brand: { name: string | null; offer: string | null; brief: string | null };
};

export const DraftSchema = z.object({
  subject_a: z.string().min(1).max(120),
  subject_b: z.string().min(1).max(120),
  email: z.string().min(20).max(2000),
  dm: z.string().min(10).max(800),
  followup_1: z.string().min(10).max(1000),
  followup_2: z.string().min(10).max(1000),
});
export type Draft = z.infer<typeof DraftSchema>;

const LANG_NAMES: Record<string, string> = { en: "English", uk: "Ukrainian", ru: "Russian", pl: "Polish", de: "German", es: "Spanish" };

/** Перше ім’я з показуваного імені, якщо воно схоже на ім’я людини; інакше — без імені. */
export function firstName(displayName: string | null): string | null {
  const w = displayName?.replace(/[^\p{L}\s'-]/gu, " ").trim().split(/\s+/)[0];
  return w && w.length >= 2 && w.length <= 20 && /^\p{Lu}/u.test(w) ? w : null;
}

export function buildFacts(c: Creator, s: Pick<Search, "brandName" | "offer" | "brief">, rawProfile: unknown): FactSheet {
  const posts = profilePosts(rawProfile).filter((p) => !p.pinned && p.caption.trim().length >= 20);
  const ads = c.ads as AdsReport | null;
  const adUrls = new Set(ads?.examples.map((e) => e.url) ?? []);
  // Згадуємо звичайний (не рекламний) допис — це читається як справжній інтерес до автора.
  const post = posts.find((p) => !adUrls.has(p.url)) ?? posts[0];
  const analysis = c.analysis as ProfileAnalysis | null;
  const audit = c.audit as VisionAudit | null;
  const deep = c.deepAudit as DeepAudit | null;
  const observations: string[] = [];
  if (audit?.aesthetic) observations.push(`visual style: ${audit.aesthetic}`);
  if (audit?.scores?.lighting?.score != null && audit.scores.lighting.score >= 4) observations.push("good, even lighting in recent posts");
  if (deep?.speaksToCamera.value === "yes") observations.push("speaks to the camera naturally");
  if (deep?.productInUse.value === "yes") observations.push("shows products in use, not just held");
  if (deep?.subtitles.value === "yes") observations.push("adds subtitles to videos");
  if (ads?.repeatBrands.length) observations.push(`brands come back to work with them again`);
  if (analysis?.ugcCreator.value === "yes") observations.push("describes themselves as a UGC creator");
  return {
    creator: {
      handle: `@${c.username}`, name: firstName(c.displayName), followers: c.followers,
      niches: analysis?.niches.map((n) => n.name) ?? [], language: c.language,
    },
    post: post ? { url: post.url, caption: post.caption.replace(/\s+/g, " ").slice(0, 300), date: post.publishedAt?.toISOString().slice(0, 10) ?? null } : null,
    observations,
    brand: { name: s.brandName?.trim() || null, offer: s.offer?.trim() || null, brief: s.brief?.trim().slice(0, 800) || null },
  };
}

const NUMBER = /(?:[$€£₴]\s?)?\d[\d.,]*(?:\s?(?:%|k\b|к\b))?/gi;
const URL_RE = /https?:\/\/[^\s)>\]]+/gi;
const HANDLE = /(?<![\w.])@[a-z0-9._]{2,30}/gi;
/** Число як токен: без валюти й пробілів, без розділювачів тисяч і кінцевої крапки. «$1,500.» → «1500». */
const numToken = (n: string) => n.toLowerCase().replace(/[$€£₴\s]/g, "").replace(/[.,]+$/, "").replace(/(\d)[.,](?=\d{3}\b)/g, "$1");

/** Перевірка чернетки: кожне число, посилання й @ім’я мають бути у фактах; мова — та, що задана. */
export function checkDraft(d: Draft, facts: FactSheet, language: string): string[] {
  const issues: string[] = [];
  const factText = JSON.stringify(facts).toLowerCase();
  const factNumbers = new Set((factText.match(NUMBER) ?? []).flatMap((n) => [numToken(n), ...numToken(n).split(/[^\dkк%]+/)]));
  const all = [d.subject_a, d.subject_b, d.email, d.dm, d.followup_1, d.followup_2].join("\n");
  for (const n of new Set((all.match(NUMBER) ?? []).map((x) => x.trim().replace(/[.,]+$/, "")))) {
    if (!factNumbers.has(numToken(n))) issues.push(`число «${n}» відсутнє у фактах`);
  }
  for (const u of new Set((all.match(URL_RE) ?? []).map((x) => x.replace(/[.,]+$/, "")))) if (!factText.includes(u.toLowerCase())) issues.push(`посилання ${u} відсутнє у фактах`);
  for (const h of new Set((all.match(HANDLE) ?? []).map((x) => x.toLowerCase().replace(/\.+$/, "")))) if (!factText.includes(h)) issues.push(`ім’я ${h} відсутнє у фактах`);
  const lang = detectLanguage(d.email.replace(/\{\{\w+\}\}/g, "")).language;
  if (lang && lang !== language) issues.push(`лист написано не тією мовою (${lang} замість ${language})`);
  if (d.email.split(/\s+/).length > 170) issues.push("лист задовгий");
  if (d.dm.split(/\s+/).length > 80) issues.push("повідомлення в директ задовге");
  return [...new Set(issues)];
}

const SYSTEM = (language: string) => `You write outreach for a brand that wants to hire a content creator. Write in ${LANG_NAMES[language] ?? language}.
${GUARD}
Rules:
- Use ONLY facts from the FACTS block. Never invent numbers, prices, dates, product names, links, results or compliments that FACTS does not support.
- Mention the creator's post from FACTS.post in a natural, specific way (what it is about), so the message is clearly not a mass mailing.
- If FACTS.brand.offer is empty, do not name any price or budget: simply ask the creator to share their rates (never mention that a budget is missing).
- Praise only what FACTS states. Do not add judgements such as "high-converting", "experienced" or "your audience loves you".
- If FACTS.brand.name is empty, do not invent a brand name; describe the product from the brief instead.
- Address the creator by FACTS.creator.name if present, otherwise without a name. Sign with ${SENDER}.
- Write on behalf of the brand team in the first person plural ("we"), so that no verb or adjective reveals the sender's gender.
- Email: under 120 words, one clear question at the end. DM: under 60 words. Follow-ups: short, polite, add no new claims.
- If an EXAMPLE is given, match its tone and length, but never copy facts from it.
Return ONLY JSON: {"subject_a": "...", "subject_b": "... (a different angle)", "email": "...", "dm": "...", "followup_1": "... (after 3-4 days)", "followup_2": "... (after a week, last one)"}`;

export type DraftOverrides = {
  /** Бренд і умови з правил клієнта замість полів пошуку. */
  brand?: Pick<Search, "brandName" | "offer" | "brief">;
  language?: string;
};

export async function generateDraft(
  db: Db, creatorId: number, searchId: number | null, overrides: DraftOverrides = {},
): Promise<{ id: number; issues: string[]; data: Draft; language: string }> {
  const [c] = await db.select().from(creators).where(eq(creators.id, creatorId));
  if (!c) throw new Error("Автора не знайдено");
  const [s] = searchId ? await db.select().from(searches).where(eq(searches.id, searchId)) : [];
  const [profile] = await db.select({ raw: contentItems.raw }).from(contentItems)
    .where(and(eq(contentItems.source, c.platform), eq(contentItems.externalId, `profile:${c.username}`)));
  const language = overrides.language ?? s?.outreachLanguage ?? "en";
  const brand = overrides.brand ?? s ?? { brandName: null, offer: null, brief: null };
  const facts = buildFacts(c, brand, profile?.raw);
  const example = s?.letterExample?.trim();
  const user = [
    dataBlock("facts", JSON.stringify(facts, null, 1)),
    example ? `EXAMPLE of the tone the brand likes (written by the brand, trusted; do not reuse its facts):\n${example.slice(0, 1500)}` : "",
  ].filter(Boolean).join("\n\n");

  const messages = [{ role: "system" as const, content: SYSTEM(language) }, { role: "user" as const, content: user }];
  let res = await chatJsonMeta(db, DraftSchema, messages, { purpose: "outreach-draft", maxTokens: 1200, cache: false });
  let issues = checkDraft(res.data, facts, language);
  if (issues.length) {
    const retry = await chatJsonMeta(db, DraftSchema, [
      ...messages,
      { role: "assistant", content: JSON.stringify(res.data) },
      { role: "user", content: `Fix these problems and return the full corrected JSON: ${issues.join("; ")}. Remove anything not supported by FACTS.` },
    ], { purpose: "outreach-draft", maxTokens: 1200, cache: false });
    const again = checkDraft(retry.data, facts, language);
    if (again.length < issues.length) {
      res = retry;
      issues = again;
    }
  }
  const [row] = await db.insert(outreachDrafts).values({
    creatorId, searchId: s?.id ?? null, language, style: example ? "example" : "standard",
    data: res.data, facts: { ...facts, version: DRAFT_VERSION, model: res.model } as unknown as Record<string, unknown>, issues,
  }).returning({ id: outreachDrafts.id });
  return { id: row.id, issues, data: res.data, language };
}
