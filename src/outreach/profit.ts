import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { clients, outreachThreads, searches, timeEntries, type ClientBilling } from "@/db/schema";
import { policyOf } from "./policy";

/**
 * Прибутковість клієнта: що він вам заплатив (абонемент за місяці роботи й/або плата за допис)
 * мінус ваші витрати (Apify на пошуки, гонорари авторам і товар — якщо за них платите ви),
 * і скільки це виходить за годину вашого часу.
 */

export type ProfitInput = {
  billing: ClientBilling;
  since: Date;
  now: Date;
  posted: number;
  shipped: number;
  apifyUsd: number;
  feesUsd: number;
  productValueUsd: number | null;
  minutes: number;
};

export type Profit = {
  months: number; revenue: number; apifyUsd: number; feesUsd: number; productUsd: number; costs: number; net: number;
  hours: number; perHour: number | null;
};

/** Скільки розрахункових місяців почалося від дати старту (абонемент платиться на початку місяця). */
export function billingMonths(since: Date, now: Date): number {
  if (now < since) return 0;
  const months = (now.getFullYear() - since.getFullYear()) * 12 + (now.getMonth() - since.getMonth()) - (now.getDate() < since.getDate() ? 1 : 0);
  return months + 1;
}

export function profitability(i: ProfitInput): Profit {
  const b = i.billing;
  const model = b.model ?? "none";
  const months = billingMonths(i.since, i.now);
  const retainer = model === "retainer" || model === "both" ? (b.retainerUsd ?? 0) * months : 0;
  const perPost = model === "per_post" || model === "both" ? (b.perPostUsd ?? 0) * i.posted : 0;
  const revenue = retainer + perPost;
  const feesUsd = b.creatorFeesBy === "me" ? i.feesUsd : 0;
  const productUsd = b.productBy === "me" ? (i.productValueUsd ?? 0) * i.shipped : 0;
  const costs = i.apifyUsd + feesUsd + productUsd;
  const net = revenue - costs;
  const hours = i.minutes / 60;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    months, revenue: r2(revenue), apifyUsd: r2(i.apifyUsd), feesUsd: r2(feesUsd), productUsd: r2(productUsd), costs: r2(costs), net: r2(net),
    hours: r2(hours), perHour: hours > 0 ? r2(net / hours) : null,
  };
}

export async function clientProfit(db: Db, clientId: number, now = new Date()): Promise<Profit & { since: Date }> {
  const [c] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!c) throw new Error("Клієнта не знайдено");
  const since = c.billing.startedAt ? new Date(`${c.billing.startedAt}T00:00:00`) : c.createdAt;
  const [[threads], [apify], [time]] = await Promise.all([
    db.select({
      posted: sql<number>`count(*) filter (where ${outreachThreads.status} = 'posted')::int`,
      shipped: sql<number>`count(*) filter (where ${outreachThreads.status} in ('shipped', 'posted'))::int`,
      fees: sql<number>`coalesce(sum((${outreachThreads.terms}->>'feeUsd')::float) filter (where ${outreachThreads.status} = 'posted'), 0)`,
    }).from(outreachThreads).where(eq(outreachThreads.clientId, clientId)),
    db.select({ usd: sql<number>`coalesce(sum((${searches.stats}->>'costUsd')::float), 0)` }).from(searches).where(eq(searches.clientId, clientId)),
    db.select({ minutes: sql<number>`coalesce(sum(${timeEntries.minutes}), 0)::int` }).from(timeEntries).where(eq(timeEntries.clientId, clientId)),
  ]);
  const p = profitability({
    billing: c.billing, since, now, posted: threads?.posted ?? 0, shipped: threads?.shipped ?? 0, apifyUsd: apify?.usd ?? 0,
    feesUsd: threads?.fees ?? 0, productValueUsd: policyOf(c.policy).productValueUsd, minutes: time?.minutes ?? 0,
  });
  return { ...p, since };
}

/** Прибутковість усіх клієнтів — для зведення. */
export async function allProfits(db: Db, ids: number[]) {
  if (!ids.length) return [];
  const rows = await db.select({ id: clients.id, name: clients.name }).from(clients).where(and(inArray(clients.id, ids)));
  return Promise.all(rows.map(async (r) => ({ ...r, ...(await clientProfit(db, r.id)) })));
}
