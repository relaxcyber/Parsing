import { isNull, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import * as schema from "./schema";
import type { Db } from "./client";
import { connect } from "./connection";
import { decryptSecret, fingerprint } from "@/keys/crypto";
import { seedProviders } from "@/keys/presets";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL не задано");
const sql = connect(url, 1);
const db = drizzle(sql, { schema }) as unknown as Db;
await migrate(db as any, { migrationsFolder: "./drizzle" });
await seedProviders(db);

// Відбитки для ключів, доданих до появи цієї колонки.
for (const k of await db.select().from(schema.apiKeys).where(isNull(schema.apiKeys.fingerprint))) {
  try {
    await db.update(schema.apiKeys).set({ fingerprint: fingerprint(decryptSecret(k.secretEnc)) }).where(eq(schema.apiKeys.id, k.id));
  } catch {
    console.warn(`Ключ «${k.label}» не розшифровується поточним MASTER_KEY або дублює інший — пропущено.`);
  }
}
// Прибирання: журнал викликів старший за 90 днів і прострочені сесії.
await db.delete(schema.usageEvents).where(lt(schema.usageEvents.at, new Date(Date.now() - 90 * 86400_000)));
await db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, new Date()));
await sql.end();
console.log("Міграції застосовано, провайдери на місці.");
