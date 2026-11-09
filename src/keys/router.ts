import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { apiKeys, providers, usageEvents, type ApiKey, type Provider } from "@/db/schema";
import { decryptSecret } from "./crypto";

export type Period = ApiKey["quotaPeriod"];

/** Початок поточного календарного періоду (UTC). */
export function periodStart(period: Period, now: Date): Date | null {
  const d = new Date(now);
  if (period === "minute") d.setUTCSeconds(0, 0);
  else if (period === "day") d.setUTCHours(0, 0, 0, 0);
  else if (period === "month") {
    d.setUTCDate(1);
    d.setUTCHours(0, 0, 0, 0);
  } else return null;
  return d;
}

export function nextPeriodStart(period: Period, now: Date): Date | null {
  const d = periodStart(period, now);
  if (!d) return null;
  if (period === "minute") d.setUTCMinutes(d.getUTCMinutes() + 1);
  else if (period === "day") d.setUTCDate(d.getUTCDate() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

/** Використання з урахуванням того, що період міг уже змінитися. */
export function effectiveUsed(key: ApiKey, now: Date): number {
  const start = periodStart(key.quotaPeriod, now);
  return start && key.periodStartedAt < start ? 0 : key.quotaUsed;
}

export type KeyState = "active" | "disabled" | "invalid" | "cooldown" | "exhausted";

export function keyState(key: ApiKey, now: Date): KeyState {
  if (key.status !== "active") return key.status;
  if (key.cooldownUntil && key.cooldownUntil > now) return "cooldown";
  if (key.quotaLimit != null && effectiveUsed(key, now) >= key.quotaLimit) return "exhausted";
  return "active";
}

/** Коли ключ знову стане придатним (для cooldown / exhausted). */
export function availableAt(key: ApiKey, now: Date): Date | null {
  const state = keyState(key, now);
  if (state === "cooldown") return key.cooldownUntil;
  if (state === "exhausted") return nextPeriodStart(key.quotaPeriod, now);
  return null;
}

export class NoKeyAvailableError extends Error {
  constructor(public provider: string, public retryAt: Date | null) {
    super(
      `Немає доступного ключа для «${provider}»` +
        (retryAt ? ` — найближчий звільниться ${retryAt.toISOString()}` : ""),
    );
  }
}

/** Помилка провайдера зі статусом HTTP — за нею роутер вирішує, чи міняти ключ. */
export class ProviderHttpError extends Error {
  constructor(public status: number, message?: string, public retryAfterSec?: number) {
    super(message ?? `HTTP ${status}`);
  }
}

export type AcquiredKey = { id: number; secret: string; provider: Provider };

export async function acquireKey(db: Db, slug: string, opts: { exclude?: number[]; now?: Date } = {}): Promise<AcquiredKey> {
  const now = opts.now ?? new Date();
  const rows = await db
    .select({ key: apiKeys, provider: providers })
    .from(apiKeys)
    .innerJoin(providers, eq(apiKeys.providerId, providers.id))
    .where(and(eq(providers.slug, slug), eq(apiKeys.status, "active")));

  const candidates = rows.filter((r) => !opts.exclude?.includes(r.key.id));
  const usable = candidates.filter((r) => keyState(r.key, now) === "active");
  if (usable.length === 0) {
    const times = candidates.map((r) => availableAt(r.key, now)).filter((d): d is Date => d != null);
    throw new NoKeyAvailableError(slug, times.length ? new Date(Math.min(...times.map(Number))) : null);
  }

  // Найбільша частка вільної квоти, далі — той, що найдовше не використовувався.
  const freeShare = (k: ApiKey) => (k.quotaLimit ? 1 - effectiveUsed(k, now) / k.quotaLimit : 1);
  usable.sort(
    (a, b) =>
      freeShare(b.key) - freeShare(a.key) ||
      (a.key.lastUsedAt?.getTime() ?? 0) - (b.key.lastUsedAt?.getTime() ?? 0),
  );
  const { key, provider } = usable[0];
  return { id: key.id, secret: decryptSecret(key.secretEnc), provider };
}

export type CallReport = {
  ok: boolean;
  /** Скільки одиниць квоти списати (запити, кредити, токени...). */
  units?: number;
  httpStatus?: number;
  retryAfterSec?: number;
  error?: string;
  purpose?: string;
  now?: Date;
};

export async function reportResult(db: Db, keyId: number, r: CallReport): Promise<void> {
  const now = r.now ?? new Date();
  const [key] = await db.select().from(apiKeys).where(eq(apiKeys.id, keyId));
  if (!key) return;
  const units = r.units ?? 1;

  const patch: Partial<ApiKey> = { lastUsedAt: now, lastError: r.ok ? null : (r.error ?? `HTTP ${r.httpStatus ?? "?"}`) };
  const start = periodStart(key.quotaPeriod, now);
  const rolled = start != null && key.periodStartedAt < start;
  if (rolled) patch.periodStartedAt = start;
  patch.quotaUsed = (rolled ? 0 : key.quotaUsed) + units;

  if (r.httpStatus === 429) {
    patch.cooldownUntil = new Date(now.getTime() + (r.retryAfterSec ?? 60) * 1000);
  } else if (r.httpStatus === 401 || r.httpStatus === 403) {
    patch.status = "invalid";
  } else if (r.httpStatus === 402) {
    // Провайдер каже, що кредити скінчилися: чекаємо нового періоду (або годину).
    patch.cooldownUntil = nextPeriodStart(key.quotaPeriod, now) ?? new Date(now.getTime() + 3600_000);
  }

  await db.update(apiKeys).set(patch).where(eq(apiKeys.id, keyId));
  await db.insert(usageEvents).values({ keyId, at: now, units, ok: r.ok, httpStatus: r.httpStatus, purpose: r.purpose });
}

const ROTATE_ON = new Set([401, 402, 403, 429]);

/**
 * Виконує виклик із ключем провайдера; на 401/402/403/429 позначає ключ
 * і пробує наступний. fn може повернути { units } через другий аргумент.
 */
export async function withKey<T>(
  db: Db,
  slug: string,
  fn: (key: AcquiredKey, usage: { units: number }) => Promise<T>,
  opts: { purpose?: string; maxAttempts?: number } = {},
): Promise<T> {
  const tried: number[] = [];
  const max = opts.maxAttempts ?? 5;
  for (;;) {
    const key = await acquireKey(db, slug, { exclude: tried });
    const usage = { units: 1 };
    try {
      const result = await fn(key, usage);
      await reportResult(db, key.id, { ok: true, units: usage.units, httpStatus: 200, purpose: opts.purpose });
      return result;
    } catch (e) {
      const http = e instanceof ProviderHttpError ? e : null;
      await reportResult(db, key.id, {
        ok: false,
        units: http && ROTATE_ON.has(http.status) ? 0 : usage.units,
        httpStatus: http?.status,
        retryAfterSec: http?.retryAfterSec,
        error: e instanceof Error ? e.message : String(e),
        purpose: opts.purpose,
      });
      tried.push(key.id);
      if (!http || !ROTATE_ON.has(http.status) || tried.length >= max) throw e;
    }
  }
}
