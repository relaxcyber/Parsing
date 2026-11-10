import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { apiKeys, providers, type ApiKey } from "@/db/schema";
import { decryptSecret } from "./crypto";

type Quota = { limit: number | null; used: number; unit: string; period: ApiKey["quotaPeriod"]; resetsAt?: Date | null };
type Fetch = typeof fetch;
type Fetcher = (f: Fetch, secret: string, current: ApiKey) => Promise<Quota>;

async function getJson(f: Fetch, url: string, secret: string): Promise<any> {
  const res = await f(url, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Провайдери, які самі повідомляють реальний залишок. Решта рахується локально. */
const FETCHERS: Record<string, Fetcher> = {
  async apify(f, secret) {
    const { data } = await getJson(f, "https://api.apify.com/v2/users/me/limits", secret);
    // Цикл оплати Apify рахується від дати реєстрації, а не з 1-го числа, тому календарне
    // обнулення вимикаємо («none»): стан ключа визначає сам провайдер під час звірки.
    const end = Date.parse(data?.monthlyUsageCycle?.endAt ?? "");
    return {
      limit: num(data?.limits?.maxMonthlyUsageUsd), used: num(data?.current?.monthlyUsageUsd) ?? 0, unit: "usd", period: "none",
      resetsAt: Number.isNaN(end) ? null : new Date(end),
    };
  },
  async firecrawl(f, secret, current) {
    const { data } = await getJson(f, "https://api.firecrawl.dev/v1/team/credit-usage", secret);
    const remaining = num(data?.remaining_credits);
    if (remaining == null) throw new Error("Firecrawl не повернув remaining_credits");
    const plan = num(data?.plan_credits);
    // Firecrawl віддає лише залишок (він буває більшим за план через бонуси). Ліміт беремо
    // з плану, інакше — заданий вручну, інакше — сам залишок; період користувача не чіпаємо.
    const manual = current.quotaUnit === "credits" ? current.quotaLimit : null;
    const limit = plan != null && plan >= remaining ? plan : manual != null && manual >= remaining ? manual : remaining;
    return { limit, used: limit - remaining, unit: "credits", period: current.quotaPeriod };
  },
  async openrouter(f, secret) {
    const { data } = await getJson(f, "https://openrouter.ai/api/v1/key", secret);
    return { limit: num(data?.limit), used: num(data?.usage) ?? 0, unit: "usd", period: "none" };
  },
};

export const canSync = (slug: string) => slug in FETCHERS;

export async function syncKeyQuota(db: Db, keyId: number, f: Fetch = fetch): Promise<{ ok: boolean; message: string }> {
  const [row] = await db
    .select({ key: apiKeys, slug: providers.slug })
    .from(apiKeys)
    .innerJoin(providers, eq(apiKeys.providerId, providers.id))
    .where(eq(apiKeys.id, keyId));
  if (!row) return { ok: false, message: "Ключ не знайдено" };
  const fetcher = FETCHERS[row.slug];
  if (!fetcher) return { ok: false, message: "Цей провайдер не віддає залишок — рахуємо локально" };

  const now = new Date();
  try {
    const q = await fetcher(f, decryptSecret(row.key.secretEnc), row.key);
    await db
      .update(apiKeys)
      .set({
        quotaLimit: q.limit, quotaUsed: q.used, quotaUnit: q.unit, quotaPeriod: q.period,
        ...(q.resetsAt !== undefined ? { providerResetsAt: q.resetsAt } : {}),
        // Провайдер підтвердив стан ключа — локальна пауза більше не потрібна.
        periodStartedAt: now, lastSyncedAt: now, lastError: null, cooldownUntil: null,
        status: row.key.status === "invalid" ? "active" : row.key.status,
      })
      .where(eq(apiKeys.id, keyId));
    return { ok: true, message: "Синхронізовано" };
  } catch (e: any) {
    const invalid = e?.status === 401;
    await db
      .update(apiKeys)
      .set({ lastError: `Синхронізація: ${e?.message ?? e}`, ...(invalid ? { status: "invalid" as const } : {}) })
      .where(eq(apiKeys.id, keyId));
    return { ok: false, message: invalid ? "Провайдер відхилив ключ" : `Помилка: ${e?.message ?? e}` };
  }
}
