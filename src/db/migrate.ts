import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema";
import { seedProviders } from "@/keys/presets";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL не задано");
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });
await migrate(db, { migrationsFolder: "./drizzle" });
await seedProviders(db);
await sql.end();
console.log("Міграції застосовано, провайдери на місці.");
