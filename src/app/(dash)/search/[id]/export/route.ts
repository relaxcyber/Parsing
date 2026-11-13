import { and, desc, eq, inArray } from "drizzle-orm";
import { profileUrl } from "@/lib/profile-url";
import { getDb } from "@/db/client";
import { creatorContacts, creators, searchCandidates, searches } from "@/db/schema";
import { isAuthed } from "@/lib/auth";
import { toCsv } from "@/search/csv";

export const dynamic = "force-dynamic";

/**
 * CSV кандидатів, що підходять. ?only=email — лише з email, по одному рядку на автора
 * (колонки email / first_name зрозумілі сервісам розсилки на кшталт Instantly чи Smartlead).
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAuthed())) return new Response("Unauthorized", { status: 401 });
  const searchId = Number((await params).id);
  const db = getDb();
  const [s] = Number.isInteger(searchId) ? await db.select().from(searches).where(eq(searches.id, searchId)) : [];
  if (!s) return new Response("Not found", { status: 404 });
  const onlyEmail = new URL(req.url).searchParams.get("only") === "email";
  const rows = await db.select({ cand: searchCandidates, c: creators }).from(searchCandidates)
    .innerJoin(creators, eq(searchCandidates.creatorId, creators.id))
    .where(and(eq(searchCandidates.searchId, searchId), eq(searchCandidates.stage, "qualified")))
    .orderBy(desc(searchCandidates.lead), desc(searchCandidates.score));
  const contacts = rows.length ? await db.select().from(creatorContacts).where(inArray(creatorContacts.creatorId, rows.map((r) => r.c.id))) : [];
  const picked = rows.filter((r) => !onlyEmail || r.c.emails.length > 0);

  const csv = toCsv(
    ["email", "first_name", "username", "profile_url", "followers", "score", "fit", "readiness", "quality", "trust", "fake_risk", "er_likes_pct",
      "ad_posts", "ad_quality", "lead", "email_status", "email_source", "last_post", "aesthetic", "source", "outreach_status", "review",
      "affiliate", "portfolio", "rates", "other_emails", "links", "bio", "reasons"],
    picked.map(({ cand, c }) => {
      const k = contacts.find((x) => x.creatorId === c.id && x.email === c.emails[0]);
      const audit = c.audit as { aesthetic?: string } | null;
      const ads = c.ads as { adPosts?: number } | null;
      return [
        c.emails[0] ?? "", (c.displayName ?? "").split(/[\s|,]/)[0] ?? "", c.username, profileUrl(c.platform, c.username), c.followers ?? "",
        Math.round(cand.score), cand.fit ?? "", cand.readiness ?? "", cand.quality ?? "", cand.trust ?? "", c.trustRisk ?? "",
        c.erLikes != null ? Math.round(c.erLikes * 10000) / 100 : "", ads?.adPosts ?? "", c.adQuality ?? "",
        cand.lead ? "yes" : "no", k?.status ?? "", k?.sourceUrl ?? "",
        c.lastPostAt ? c.lastPostAt.toISOString().slice(0, 10) : "", audit?.aesthetic ?? "", cand.source ?? "", c.outreachStatus, c.reviewNote ?? "",
        c.affiliate.join("; "), c.portfolio.join("; "),
        c.rates.map((r) => r.title).join("; "), c.emails.slice(1).join("; "), c.links.join("; "), c.bio ?? "", cand.reasons.join("; "),
      ];
    }),
  );
  return new Response(csv, {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="search-${searchId}${onlyEmail ? "-outreach" : ""}.csv"` },
  });
}
