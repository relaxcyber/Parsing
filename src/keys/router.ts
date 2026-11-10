import { and, eq, sql } from "drizzle-orm";
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

/** Провайдер відповів помилкою, але нічого не списав (напр. Firecrawl success:false). */
export class NotChargedError extends Error {}

export type AcquiredKey = { id: number; secret: string; provider: Provider };

export async function acquireKey(db: Db, slug: string, opts: { exclude?: number[]; now?: Date } = {}): Promise<AcquiredKey> {
  const now = opts.now ?? new Date();
  // Вибір і позначка «щойно взято» — в одній транзакції з блокуванням рядків,
  // щоб паралельні задачі розходилися по різних ключах, а не брали той самий.
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ key: apiKeys, provider: providers })
      .from(apiKeys)
      .innerJoin(providers, eq(apiKeys.providerId, providers.id))
      .where(and(eq(providers.slug, slug), eq(apiKeys.status, "active")))
      .for("update", { of: apiKeys });

    const candidates = rows.filter((r) => !opts.exclude?.includes(r.key.id));
    const usable = candidates.filter((r) => keyState(r.key, now) === "active");
    if (usable.length === 0) {
      const times = candidates.map((r) => availableAt(r.key, now)).filter((d): d is Date => d != null);
      throw new NoKeyAvailableError(slug, times.length ? new Date(Math.min(...times.map(Number))) : null);
    }

    // Спершу — у кого помітно більше вільної квоти (кроком 10%), серед рівних — хто довше чекав.
    const bucket = (k: ApiKey) => (k.quotaLimit ? Math.round((1 - effectiveUsed(k, now) / k.quotaLimit) * 10) : 10);
    usable.sort(
      (a, b) =>
        bucket(b.key) - bucket(a.key) ||
        (a.key.lastUsedAt?.getTime() ?? 0) - (b.key.lastUsedAt?.getTime() ?? 0) ||
        a.key.id - b.key.id,
    );
    const { key, provider } = usable[0];
    // Позначка завжди пізніша за всі попередні, навіть у межах однієї мілісекунди —
    // інакше черга «хто довше чекав» злипається при одночасних запитах.
    const latest = Math.max(0, ...rows.map((r) => r.key.lastUsedAt?.getTime() ?? 0));
    await tx.update(apiKeys).set({ lastUsedAt: new Date(Math.max(now.getTime(), latest + 1)) }).where(eq(apiKeys.id, key.id));
    return { id: key.id, secret: decryptSecret(key.secretEnc), provider };
  });
}

/** Драйвер загортає помилку бази, тому код шукаємо по всьому ланцюжку cause. */
function isForeignKeyViolation(e: unknown): boolean {
  for (let cur: any = e, i = 0; cur && i < 5; cur = cur.cause, i++) {
    if (cur.code === "23503" || /foreign key constraint/i.test(String(cur.message))) return true;
  }
  return false;
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
  const units = r.units ?? 1;
  const nowSql = sql`${now.toISOString()}::timestamptz`;
  // Усе рахує сама база одним UPDATE: паралельні звіти не затирають один одного.
  const start = sql`case when ${apiKeys.quotaPeriod} = 'none' then null else date_trunc(${apiKeys.quotaPeriod}::text, ${nowSql}, 'UTC') end`;
  const rolled = sql`coalesce(${apiKeys.periodStartedAt} < (${start}), false)`;
  // Для періоду «none» наступного періоду немає — пауза на годину (далі ключ перевірить звірка).
  const step = sql`case ${apiKeys.quotaPeriod} when 'minute' then interval '1 minute' when 'day' then interval '1 day' when 'month' then interval '1 month' end`;
  const nextPeriod = sql`coalesce((${start}) + (${step}), ${nowSql} + interval '1 hour')`;

  const cooldown =
    r.httpStatus === 429
      ? sql`${new Date(now.getTime() + (r.retryAfterSec ?? 60) * 1000).toISOString()}::timestamptz`
      : r.httpStatus === 402
        ? nextPeriod // кредити скінчилися: чекаємо нового періоду (або годину)
        : r.httpStatus === 403
          ? sql`${nowSql} + interval '10 minutes'` // 403 буває і про конкретний сайт/актор, а не про ключ
          : sql`${apiKeys.cooldownUntil}`;

  await db.transaction(async (tx) => {
    await tx
      .update(apiKeys)
      .set({
        quotaUsed: sql`case when ${rolled} then ${units} else ${apiKeys.quotaUsed} + ${units} end`,
        periodStartedAt: sql`case when ${rolled} then (${start}) else ${apiKeys.periodStartedAt} end`,
        lastUsedAt: now,
        lastError: r.ok ? null : (r.error ?? `HTTP ${r.httpStatus ?? "?"}`).slice(0, 500),
        cooldownUntil: cooldown,
        ...(r.httpStatus === 401 ? { status: "invalid" as const } : {}),
      })
      .where(eq(apiKeys.id, keyId));
    await tx.insert(usageEvents).values({ keyId, at: now, units, ok: r.ok, httpStatus: r.httpStatus, purpose: r.purpose });
  }).catch((e) => {
    // Ключ могли видалити під час виклику — це не привід валити збір.
    if (!isForeignKeyViolation(e)) throw e;
  });
}

/**
 * Звіряє з провайдером ключі, які локально вважаються вичерпаними або на паузі.
 * Повертає true, якщо хоч один ключ звірено (тобто є сенс спробувати ще раз).
 */
async function resyncUnavailable(db: Db, slug: string): Promise<boolean> {
  const { canSync, syncKeyQuota } = await import("./quota-sync");
  if (!canSync(slug)) return false;
  const now = new Date();
  const rows = await db
    .select({ key: apiKeys })
    .from(apiKeys)
    .innerJoin(providers, eq(apiKeys.providerId, providers.id))
    .where(and(eq(providers.slug, slug), eq(apiKeys.status, "active")));
  const stale = rows.filter(({ key }) => keyState(key, now) !== "active" && (!key.lastSyncedAt || now.getTime() - key.lastSyncedAt.getTime() > 5 * 60_000));
  const results = await Promise.all(stale.map(({ key }) => syncKeyQuota(db, key.id).catch(() => ({ ok: false }))));
  return results.some((r) => r.ok);
}

const ROTATE_ON = new Set([401, 402, 403, 429]);

/**
 * Виконує виклик із ключем провайдера; на 401/402/403/429 позначає ключ
 * і пробує наступний. fn може уточнити списані одиниці через другий аргумент.
 * retryTransient: для ідемпотентних викликів — повторити на іншому ключі при 5xx або збої мережі.
 */
export async function withKey<T>(
  db: Db,
  slug: string,
  fn: (key: AcquiredKey, usage: { units: number }) => Promise<T>,
  opts: { purpose?: string; maxAttempts?: number; retryTransient?: boolean } = {},
): Promise<T> {
  const tried: number[] = [];
  const max = opts.maxAttempts ?? 5;
  let transientLeft = opts.retryTransient ? 2 : 0;
  let lastError: unknown;
  let resynced = false;
  for (;;) {
    let key: AcquiredKey;
    try {
      key = await acquireKey(db, slug, { exclude: tried });
    } catch (e) {
      if (!(e instanceof NoKeyAvailableError)) throw e;
      // Ключі скінчилися вже після невдалих спроб — показуємо справжню причину.
      if (lastError) throw lastError;
      // Локальний облік міг відстати від провайдера (новий цикл оплати) — звіряємо й пробуємо ще раз.
      if (resynced || !(await resyncUnavailable(db, slug))) throw e;
      resynced = true;
      continue;
    }
    const usage = { units: 1 };
    let result: T;
    let failed = false;
    try {
      result = await fn(key, usage);
    } catch (e) {
      failed = true;
      lastError = e;
      const http = e instanceof ProviderHttpError ? e : null;
      const rotate = !!http && ROTATE_ON.has(http.status);
      const transient = !rotate && (http ? http.status >= 500 : e instanceof TypeError || (e as Error)?.name === "TimeoutError");
      await reportResult(db, key.id, {
        ok: false,
        // Відмова без виконання роботи квоту не витрачає.
        units: rotate || transient || e instanceof NotChargedError ? 0 : usage.units,
        httpStatus: http?.status,
        retryAfterSec: http?.retryAfterSec,
        error: e instanceof Error ? e.message : String(e),
        purpose: opts.purpose,
      });
      tried.push(key.id);
      if (tried.length >= max) throw e;
      if (!rotate && !(transient && transientLeft-- > 0)) throw e;
    }
    if (failed) continue;
    // Звіт про успіх — поза try: збій запису в базу не має перетворити оплачений результат на помилку.
    await reportResult(db, key.id, { ok: true, units: usage.units, httpStatus: 200, purpose: opts.purpose }).catch((e) =>
      console.error("Не вдалося записати використання ключа:", e),
    );
    return result!;
  }
}
