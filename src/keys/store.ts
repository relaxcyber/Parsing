import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { apiKeys, providers, type ApiKey } from "@/db/schema";
import { decryptSecret, encryptSecret, secretTail } from "./crypto";
import { canSync, syncKeyQuota } from "./quota-sync";

export type NewKey = {
  providerId: number;
  label: string;
  secret: string;
  quotaLimit?: number | null;
  quotaUnit?: string;
  quotaPeriod?: ApiKey["quotaPeriod"];
};

export type AddKeyResult = { status: "added" | "duplicate" | "no-provider"; message: string };

/** Зберігає ключ (зашифрованим) і, якщо провайдер уміє, одразу звіряє залишок. */
export async function addKey(db: Db, input: NewKey): Promise<AddKeyResult> {
  const [provider] = await db.select().from(providers).where(eq(providers.id, input.providerId));
  if (!provider) return { status: "no-provider", message: "Провайдера не знайдено" };

  const existing = await db.select().from(apiKeys).where(eq(apiKeys.providerId, provider.id));
  if (existing.some((k) => decryptSecret(k.secretEnc) === input.secret)) {
    return { status: "duplicate", message: "Такий ключ уже додано" };
  }

  const { secret, ...rest } = input;
  const [row] = await db
    .insert(apiKeys)
    .values({ ...rest, secretEnc: encryptSecret(secret), secretTail: secretTail(secret) })
    .returning({ id: apiKeys.id });
  if (!canSync(provider.slug)) return { status: "added", message: "Ключ додано" };
  const r = await syncKeyQuota(db, row.id);
  return {
    status: "added",
    message: r.ok ? "Ключ додано, залишок отримано від провайдера" : `Ключ додано, але перевірка не вдалася. ${r.message}`,
  };
}
