import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Db } from "@/db/client";
import { encryptSecret } from "@/keys/crypto";
import { seedProviders } from "@/keys/presets";
import { eq } from "drizzle-orm";

process.env.MASTER_KEY ??= "test-master-key-0123456789";

export async function testDb(): Promise<Db> {
  const db = drizzle(new PGlite(), { schema }) as unknown as Db;
  await migrate(db as any, { migrationsFolder: "./drizzle" });
  await seedProviders(db);
  return db;
}

export async function addTestKey(db: Db, slug: string, secret: string, extra: Partial<typeof schema.apiKeys.$inferInsert> = {}) {
  const [p] = await db.select().from(schema.providers).where(eq(schema.providers.slug, slug));
  const [row] = await db
    .insert(schema.apiKeys)
    .values({ providerId: p.id, label: secret, secretEnc: encryptSecret(secret), secretTail: "", ...extra })
    .returning();
  return row;
}
