/**
 * Масове додавання ключів із локального файлу (не потрапляє в git):
 *   npm run keys:import -- keys.txt
 * Рядок: провайдер | назва | ключ [| ліміт | одиниця | період]
 * Провайдер — slug або назва (groq, apify, firecrawl, gemini, openrouter, ...).
 */
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import { connect } from "@/db/connection";
import * as schema from "@/db/schema";
import type { Db } from "@/db/client";
import { addKey } from "./store";

const UNITS = ["requests", "credits", "tokens", "usd"];
const PERIODS = ["minute", "day", "month", "none"] as const;

export async function importKeys(db: Db, text: string): Promise<string[]> {
  const providers = await db.select().from(schema.providers);
  const report: string[] = [];
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [prov, label, secret, limit, unit, period] = line.split("|").map((p) => p.trim());
    const where = `Рядок ${i + 1}`;
    const provider = providers.find((p) => p.slug === prov?.toLowerCase() || p.name.toLowerCase() === prov?.toLowerCase());
    if (!provider) { report.push(`${where}: невідомий провайдер «${prov}»`); continue; }
    if (!label || !secret) { report.push(`${where}: потрібні назва і ключ`); continue; }
    const quotaLimit = limit ? Number(limit) : null;
    if (quotaLimit != null && !(quotaLimit > 0)) { report.push(`${where}: ліміт має бути числом більше нуля`); continue; }
    if (unit && !UNITS.includes(unit)) { report.push(`${where}: одиниця — одна з ${UNITS.join(", ")}`); continue; }
    if (period && !(PERIODS as readonly string[]).includes(period)) { report.push(`${where}: період — один з ${PERIODS.join(", ")}`); continue; }
    const r = await addKey(db, {
      providerId: provider.id, label, secret, quotaLimit,
      quotaUnit: unit || "requests",
      quotaPeriod: (period as (typeof PERIODS)[number]) || (provider.kind === "llm" ? "day" : "month"),
    });
    report.push(`${where}: ${provider.name} «${label}» — ${r.message}`);
  }
  return report;
}

if (process.argv[1]?.endsWith("import.ts")) {
  const file = process.argv[2];
  if (!file) throw new Error("Вкажіть файл: npm run keys:import -- keys.txt");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL не задано");
  const sql = connect(process.env.DATABASE_URL, 1);
  const lines = await importKeys(drizzle(sql, { schema }) as unknown as Db, readFileSync(file, "utf8"));
  console.log(lines.join("\n") || "Файл порожній");
  await sql.end();
}
