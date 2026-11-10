import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { scrapeJobs, scrapeResults } from "@/db/schema";
import { isAuthed } from "@/lib/auth";
import { toCsv } from "@/search/csv";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAuthed())) return new Response("Unauthorized", { status: 401 });
  const jobId = Number((await params).id);
  const db = getDb();
  const [job] = Number.isInteger(jobId) ? await db.select().from(scrapeJobs).where(eq(scrapeJobs.id, jobId)) : [];
  if (!job) return new Response("Not found", { status: 404 });
  const rows = await db.select().from(scrapeResults).where(eq(scrapeResults.jobId, jobId)).orderBy(asc(scrapeResults.id));
  const ok = rows.filter((r) => !r.error);

  if (new URL(req.url).searchParams.get("format") === "json") {
    return new Response(JSON.stringify(ok.map((r) => ({ url: r.url, ...r.data, fetched_at: r.fetchedAt.toISOString() })), null, 2), {
      headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="scrape-${jobId}.json"` },
    });
  }
  const columns = [...new Set(ok.flatMap((r) => Object.keys(r.data)))];
  const csv = toCsv(["url", ...columns, "fetched_at"], ok.map((r) => [r.url, ...columns.map((c) => r.data[c] ?? ""), r.fetchedAt.toISOString()]));
  return new Response(csv, {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="scrape-${jobId}.csv"` },
  });
}
