import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { orders } from "@/db/schema";
import { isAuthed } from "@/lib/auth";
import { clientCsv } from "@/orders/review";

export const dynamic = "force-dynamic";

/** Файл для клієнта: лише перевірені автори, зрозумілі колонки англійською. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAuthed())) return new Response("Unauthorized", { status: 401 });
  const id = Number((await params).id);
  const [o] = Number.isInteger(id) ? await getDb().select().from(orders).where(eq(orders.id, id)) : [];
  if (!o) return new Response("Not found", { status: 404 });
  const { csv } = await clientCsv(getDb(), o);
  const name = (o.spec?.brand || o.title).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 40) || "creators";
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="creators-${encodeURIComponent(name)}.csv"`,
    },
  });
}
