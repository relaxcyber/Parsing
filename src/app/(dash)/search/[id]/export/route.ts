import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { creators, searchCandidates, searches } from "@/db/schema";
import { isAuthed } from "@/lib/auth";
import { toCsv } from "@/search/csv";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAuthed())) return new Response("Unauthorized", { status: 401 });
  const searchId = Number((await params).id);
  const db = getDb();
  const [s] = Number.isInteger(searchId) ? await db.select().from(searches).where(eq(searches.id, searchId)) : [];
  if (!s) return new Response("Not found", { status: 404 });
  const rows = await db.select({ cand: searchCandidates, c: creators }).from(searchCandidates)
    .innerJoin(creators, eq(searchCandidates.creatorId, creators.id))
    .where(and(eq(searchCandidates.searchId, searchId), eq(searchCandidates.stage, "qualified")))
    .orderBy(desc(searchCandidates.score));

  const csv = toCsv(
    ["username", "profile_url", "name", "followers", "score", "fit", "readiness", "email", "links", "bio", "reasons"],
    rows.map(({ cand, c }) => [
      c.username, `https://www.instagram.com/${c.username}/`, c.displayName ?? "", c.followers ?? "", cand.score, cand.fit ?? "", cand.readiness ?? "",
      c.emails.join("; "), c.links.join("; "), c.bio ?? "", cand.reasons.join("; "),
    ]),
  );
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="search-${searchId}.csv"`,
    },
  });
}
