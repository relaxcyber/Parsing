import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { and, eq, inArray } from "drizzle-orm";
import { collagePath, deepCollagePath } from "@/audit/vision";
import type { Db } from "@/db/client";
import { contentItems, creatorContacts, creators, suppressions } from "@/db/schema";

export const usernameKey = (platform: string, username: string) => `${platform}:${username.toLowerCase()}`;
export const emailKey = (email: string) => `email:${createHash("sha256").update(email.trim().toLowerCase()).digest("hex")}`;

/** Які з цих ключів у списку виключень. */
export async function suppressedSet(db: Db, keys: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < keys.length; i += 500) {
    const rows = await db.select({ key: suppressions.key }).from(suppressions).where(inArray(suppressions.key, keys.slice(i, i + 500)));
    rows.forEach((r) => found.add(r.key));
  }
  return found;
}

/**
 * Право на заперечення (GDPR ст. 21): видаляє автора з усіма його даними й заносить
 * у список виключень, щоб наступні пошуки його більше не збирали. Email зберігається лише як хеш.
 */
export async function suppressCreator(db: Db, creatorId: number, reason: string): Promise<boolean> {
  const [c] = await db.select().from(creators).where(eq(creators.id, creatorId));
  if (!c) return false;
  const contacts = await db.select({ email: creatorContacts.email }).from(creatorContacts).where(eq(creatorContacts.creatorId, creatorId));
  const keys = [usernameKey(c.platform, c.username), ...new Set([...c.emails, ...contacts.map((x) => x.email)].map(emailKey))];
  await db.insert(suppressions).values(keys.map((key) => ({ key, reason }))).onConflictDoNothing();
  await db.delete(contentItems).where(and(eq(contentItems.source, c.platform), eq(contentItems.authorUsername, c.username)));
  await db.delete(contentItems).where(and(eq(contentItems.source, c.platform), eq(contentItems.externalId, `profile:${c.username}`)));
  await db.delete(creators).where(eq(creators.id, creatorId)); // кандидати й контакти видаляються каскадом
  await rm(collagePath(creatorId), { force: true }).catch(() => {});
  await rm(deepCollagePath(creatorId), { force: true }).catch(() => {});
  return true;
}
