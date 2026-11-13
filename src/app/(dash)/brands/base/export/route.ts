import { baseRows, brandBase, rowsCsv } from "@/brands";
import { getDb } from "@/db/client";
import { isAuthed } from "@/lib/auth";
import { filterOf, type BaseParams } from "../filter";

export const dynamic = "force-dynamic";

/** База брендів з поточними фільтрами — файл для креатора з цифрами співпраці. */
export async function GET(req: Request) {
  if (!(await isAuthed())) return new Response("Unauthorized", { status: 401 });
  const p = Object.fromEntries(new URL(req.url).searchParams) as BaseParams;
  const { csv } = rowsCsv(baseRows(await brandBase(getDb(), filterOf(p))));
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="brands-base.csv"' } });
}
