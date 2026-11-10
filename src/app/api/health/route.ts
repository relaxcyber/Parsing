import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";

export const dynamic = "force-dynamic";

/** Для скрипта запуску: чи це наш застосунок, чи доступна база і чи задано секрети. */
export async function GET() {
  const problems: string[] = [];
  if (!process.env.MASTER_KEY || process.env.MASTER_KEY.length < 16) problems.push("MASTER_KEY не задано або коротший за 16 символів");
  if (!process.env.DASHBOARD_PASSWORD) problems.push("DASHBOARD_PASSWORD не задано");
  try {
    await getDb().execute(sql`select 1`);
  } catch (e) {
    problems.push(`База даних недоступна: ${e instanceof Error ? e.message : e}`);
  }
  return Response.json({ app: "parsing", ok: problems.length === 0, problems }, { status: problems.length ? 503 : 200 });
}
