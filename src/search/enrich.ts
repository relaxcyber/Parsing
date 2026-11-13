import { sql, eq } from "drizzle-orm";
import { profileUrl as profileUrlOf } from "@/lib/profile-url";
import { getPageHtml } from "@/collect/html";
import type { Db } from "@/db/client";
import { creatorContacts, creators, type Creator, type CreatorRate } from "@/db/schema";
import { checkEmail, usable, type EmailCheck } from "@/enrich/email";
import { extractLinkPage } from "@/enrich/linkpage";
import { classifyLinks } from "@/enrich/links";
import { extractEmails } from "./signals";
import { emailKey, suppressedSet } from "./suppress";

/** Сторінки-візитки автора: до двох посилань, спершу відомі сервіси, потім власні сайти. */
function pagesToVisit(c: Creator): string[] {
  const { hubs } = classifyLinks(c.links);
  const others = c.links.filter((l) => !hubs.includes(l) && !/(instagram|tiktok|youtube|facebook|amazon|amzn|shopltk|liketk|shopmy|spotify|apple|google|whatsapp|t\.me|x\.com|twitter)\./i.test(l));
  return [...hubs, ...others].slice(0, 2);
}

type Enrichment = { emails: { email: string; source: string; sourceUrl: string }[]; rates: CreatorRate[]; portfolio: string[]; affiliate: string[]; socials: Record<string, string>; pages: number };

/** Безкоштовне збагачення: біо + посилання профілю + сторінки-візитки. */
async function collectContacts(c: Creator): Promise<Enrichment> {
  const profileUrl = profileUrlOf(c.platform, c.username);
  const fromProfile = classifyLinks(c.links);
  const out: Enrichment = {
    emails: extractEmails(c.bio).map((email) => ({ email, source: "bio", sourceUrl: profileUrl })),
    rates: [], portfolio: [...fromProfile.portfolio], affiliate: [...fromProfile.affiliate], socials: { ...fromProfile.socials }, pages: 0,
  };
  for (const url of pagesToVisit(c)) {
    let page;
    try {
      page = await getPageHtml(url);
    } catch {
      continue; // внутрішня адреса чи некоректне посилання
    }
    if ("error" in page) continue;
    out.pages++;
    const data = extractLinkPage(page.html, url);
    for (const e of data.emails) if (!out.emails.some((x) => x.email === e.email)) out.emails.push({ email: e.email, source: "link_page", sourceUrl: url });
    for (const o of data.offers) if (o.ugcRate) out.rates.push({ title: o.title, amount: o.amount, currency: o.currency, sourceUrl: url });
    out.portfolio.push(...data.portfolio);
    out.affiliate.push(...data.affiliate);
    out.socials = { ...data.socials, ...out.socials };
  }
  out.portfolio = [...new Set(out.portfolio)].slice(0, 5);
  out.affiliate = [...new Set(out.affiliate)];
  out.rates = out.rates.slice(0, 10);
  return out;
}

/** Контакти й посилання автора з перевіркою email; повертає оновлений рядок і кількість відкритих сторінок. */
export async function enrichCreator(db: Db, c: Creator): Promise<{ creator: Creator; pages: number }> {
  const e = await collectContacts(c);
  const blockedEmails = await suppressedSet(db, e.emails.map((x) => emailKey(x.email)));
  const checks: (EmailCheck & { source: string; sourceUrl: string })[] = [];
  for (const found of e.emails.filter((x) => !blockedEmails.has(emailKey(x.email))).slice(0, 5)) {
    checks.push({ ...(await checkEmail(found.email)), source: found.source, sourceUrl: found.sourceUrl });
  }
  if (checks.length) {
    await db.insert(creatorContacts)
      .values(checks.map((k) => ({ creatorId: c.id, email: k.email, status: k.status, confidence: k.confidence, mx: k.mx, source: k.source, sourceUrl: k.sourceUrl })))
      .onConflictDoUpdate({
        target: [creatorContacts.creatorId, creatorContacts.email],
        set: { status: sql`excluded.status`, confidence: sql`excluded.confidence`, mx: sql`excluded.mx`, checkedAt: new Date() },
      });
  }
  const good = checks.filter(usable).sort((a, b) => b.confidence - a.confidence).map((k) => k.email);
  const [updated] = await db.update(creators)
    .set({ emails: good, rates: e.rates, portfolio: e.portfolio, affiliate: e.affiliate, socials: e.socials, linksCheckedAt: new Date(), updatedAt: new Date() })
    .where(eq(creators.id, c.id)).returning();
  return { creator: updated ?? c, pages: e.pages };
}
