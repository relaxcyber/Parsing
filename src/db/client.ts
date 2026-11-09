import { drizzle } from "drizzle-orm/postgres-js";
import type { PgDatabase } from "drizzle-orm/pg-core";
import postgres from "postgres";
import * as schema from "./schema";

/** Тип, спільний для postgres-js (прод) і PGlite (тести). */
export type Db = PgDatabase<any, typeof schema>;

const g = globalThis as unknown as { __db?: Db };

export function getDb(): Db {
  if (!g.__db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL не задано (див. .env.example)");
    g.__db = drizzle(postgres(url, { max: 5 }), { schema });
  }
  return g.__db;
}
