import { readFile } from "node:fs/promises";
import { collagePath, deepCollagePath } from "@/audit/vision";
import { isAuthed } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Колаж аудиту; ?deep=1 — кадри з роликів глибокого аудиту. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAuthed())) return new Response("Unauthorized", { status: 401 });
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return new Response("Not found", { status: 404 });
  try {
    return new Response(new Uint8Array(await readFile(new URL(req.url).searchParams.get("deep") ? deepCollagePath(id) : collagePath(id))), {
      headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=3600" },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
