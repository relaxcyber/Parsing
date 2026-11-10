import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { apiKeys, providers, type ApiKey } from "@/db/schema";
import { encryptSecret, fingerprint, secretTail } from "./crypto";
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

  const { secret, ...rest } = input;
  // Унікальний індекс (provider_id, fingerprint) відсікає дублікати навіть при одночасних запитах.
  const [row] = await db
    .insert(apiKeys)
    .values({ ...rest, secretEnc: encryptSecret(secret), secretTail: secretTail(secret), fingerprint: fingerprint(secret) })
    .onConflictDoNothing({ target: [apiKeys.providerId, apiKeys.fingerprint] })
    .returning({ id: apiKeys.id });
  if (!row) return { status: "duplicate", message: "Такий ключ уже додано" };
  if (!canSync(provider.slug)) return { status: "added", message: "Ключ додано" };
  const r = await syncKeyQuota(db, row.id);
  return {
    status: "added",
    message: r.ok ? "Ключ додано, залишок отримано від провайдера" : `Ключ додано, але перевірка не вдалася. ${r.message}`,
  };
}
