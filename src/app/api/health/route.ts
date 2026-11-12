import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";

export const dynamic = "force-dynamic";

/**
 * Для скрипта запуску й сторожа: чи це наш застосунок, чи доступна база і чи задано секрети.
 * Відповідає завжди за кілька секунд: без мережі запит до бази висить до 30 с, і сторож прийняв би
 * це за зависання сервера й перезапускав би його по колу.
 */
export async function GET() {
  const problems: string[] = [];
  if (!process.env.MASTER_KEY || process.env.MASTER_KEY.length < 16) problems.push("MASTER_KEY не задано або коротший за 16 символів");
  if (!process.env.DASHBOARD_PASSWORD) problems.push("DASHBOARD_PASSWORD не задано");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      getDb().execute(sql`select 1`),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("немає відповіді за 4 с (мережа чи Supabase)")), 4000); }),
    ]);
  } catch (e) {
    problems.push(`База даних недоступна: ${e instanceof Error ? e.message : e}`);
  } finally {
    clearTimeout(timer);
  }
  return Response.json({ app: "parsing", ok: problems.length === 0, problems }, { status: problems.length ? 503 : 200 });
}
