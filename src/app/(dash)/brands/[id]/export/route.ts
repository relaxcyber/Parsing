import { eq } from "drizzle-orm";
import { rowsCsv, scoutMetrics, scoutRows } from "@/brands";
import { getDb } from "@/db/client";
import { brandScouts } from "@/db/schema";
import { isAuthed } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Файл для креатора: бренди, контакти, докази співпраці й готові листи. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAuthed())) return new Response("Unauthorized", { status: 401 });
  const id = Number((await params).id);
  const [s] = Number.isInteger(id) ? await getDb().select().from(brandScouts).where(eq(brandScouts.id, id)) : [];
  if (!s) return new Response("Not found", { status: 404 });
  const name = s.niche.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 40) || "brands";
  const { csv } = rowsCsv(scoutRows(s, await scoutMetrics(getDb(), s)));
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="brands-${encodeURIComponent(name)}.csv"`,
    },
  });
}
