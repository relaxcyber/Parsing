import { desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { creators, outreachDrafts, searchCandidates, searches } from "@/db/schema";
import { median } from "@/analysis/posts";
import { sizeBucket, type Bucket } from "@/analysis/trust";
import { PrintButton } from "../creators/print-button";

const usd = (n: number | null | undefined) => (n == null ? "—" : `$${n.toFixed(2).replace(".", ",")}`);
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");

/** Звіт про вашу роботу: воронка від знайдених до найнятих, витрати, ціна ліда, відповіді за стилем листа, ставки. */
export default async function WorkReport() {
  const db = getDb();
  const [[funnel], statuses, costs, drafts, rated] = await Promise.all([
    db.select({
      found: sql<number>`count(distinct ${searchCandidates.creatorId})::int`,
      qualified: sql<number>`count(distinct ${searchCandidates.creatorId}) filter (where ${searchCandidates.stage} = 'qualified')::int`,
      leads: sql<number>`count(distinct ${searchCandidates.creatorId}) filter (where ${searchCandidates.lead})::int`,
    }).from(searchCandidates),
    db.select({ s: creators.outreachStatus, n: sql<number>`count(*)::int` }).from(creators).groupBy(creators.outreachStatus),
    db.select({ stats: searches.stats }).from(searches),
    // Остання чернетка кожного автора — за її стилем рахуємо частку відповідей.
    db.selectDistinctOn([outreachDrafts.creatorId], { creatorId: outreachDrafts.creatorId, style: outreachDrafts.style })
      .from(outreachDrafts).orderBy(outreachDrafts.creatorId, desc(outreachDrafts.createdAt)),
    db.select({ followers: creators.followers, rates: creators.rates }).from(creators).where(sql`jsonb_array_length(${creators.rates}) > 0`),
  ]);
  const st = (s: string) => statuses.find((x) => x.s === s)?.n ?? 0;
  const contacted = st("contacted") + st("replied") + st("in_work") + st("posted") + st("declined");
  const replied = st("replied") + st("in_work") + st("posted");
  const spent = costs.reduce((a, r) => a + (r.stats.costUsd ?? 0), 0);

  const draftCreators = drafts.map((d) => d.creatorId);
  const draftStatus = draftCreators.length
    ? await db.select({ id: creators.id, s: creators.outreachStatus }).from(creators).where(inArray(creators.id, draftCreators))
    : [];
  const byStyle = new Map<string, { sent: number; replied: number }>();
  for (const d of drafts) {
    const s = draftStatus.find((x) => x.id === d.creatorId)?.s;
    if (!s || s === "new") continue;
    const e = byStyle.get(d.style) ?? { sent: 0, replied: 0 };
    e.sent++;
    if (s === "replied" || s === "in_work" || s === "posted") e.replied++;
    byStyle.set(d.style, e);
  }

  const buckets = new Map<Bucket, number[]>();
  for (const r of rated) {
    if (r.followers == null) continue;
    const usdRates = r.rates.filter((x) => x.currency === "USD" && x.amount > 0).map((x) => x.amount);
    if (usdRates.length) buckets.set(sizeBucket(r.followers), [...(buckets.get(sizeBucket(r.followers)) ?? []), Math.min(...usdRates)]);
  }
  const [{ n: searchesDone }] = await db.select({ n: sql<number>`count(*)::int` }).from(searches).where(eq(searches.status, "done"));

  const steps = [
    ["Знайдено авторів", funnel.found], ["Пройшли відбір", funnel.qualified], ["Готові ліди", funnel.leads],
    ["Написали", contacted], ["Відповіли", replied], ["У роботі", st("in_work") + st("posted")], ["Опублікували", st("posted")],
  ] as const;

  return (
    <>
      <div className="actions no-print" style={{ float: "right" }}><PrintButton /></div>
      <h1>Звіт про роботу</h1>
      <p className="sub">Завершених пошуків: {searchesDone}. Витрачено в Apify: {usd(spent)}{funnel.leads ? ` · ${usd(spent / funnel.leads)} за готовий лід` : ""}{st("in_work") + st("posted") ? ` · ${usd(spent / (st("in_work") + st("posted")))} за автора в роботі` : ""}{st("posted") ? ` · ${usd(spent / st("posted"))} за опублікований допис` : ""}.</p>

      <section className="card">
        <h2>Воронка</h2>
        <table>
          <thead><tr><th>Етап</th><th className="num">Авторів</th><th className="num">Від попереднього</th></tr></thead>
          <tbody>
            {steps.map(([label, n], i) => (
              <tr key={label}><td>{label}</td><td className="num"><b>{n}</b></td><td className="num">{i ? pct(n, steps[i - 1][1]) : ""}</td></tr>
            ))}
          </tbody>
        </table>
        <p className="muted">«Написали» й далі — за статусами, які ви ставите в картці автора. Відмов: {st("declined")}.</p>
      </section>

      <section className="card">
        <h2>Відповіді за стилем листа</h2>
        {byStyle.size === 0 ? <p className="muted">Поки немає чернеток, після яких ви змінили статус автора.</p> : (
          <table>
            <thead><tr><th>Стиль</th><th className="num">Написали</th><th className="num">Відповіли</th><th className="num">Частка відповідей</th></tr></thead>
            <tbody>
              {[...byStyle.entries()].map(([style, x]) => (
                <tr key={style}><td>{style === "example" ? "у тоні вашого прикладу" : "стандартний"}</td><td className="num">{x.sent}</td><td className="num">{x.replied}</td><td className="num">{pct(x.replied, x.sent)}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Ставки UGC за розміром аудиторії</h2>
        {buckets.size === 0 ? <p className="muted">Прайсів у доларах ще не знайдено — вони з’являються, коли автори публікують ціни на сторінках-візитках.</p> : (
          <table>
            <thead><tr><th>Аудиторія</th><th className="num">Прайсів</th><th className="num">Медіана від</th><th className="num">Діапазон</th></tr></thead>
            <tbody>
              {(["<10k", "10–50k", "50–250k", "250k–1M", ">1M"] as Bucket[]).filter((b) => buckets.has(b)).map((b) => {
                const xs = buckets.get(b)!;
                return <tr key={b}><td>{b}</td><td className="num">{xs.length}</td><td className="num">{usd(median(xs))}</td><td className="num">{usd(Math.min(...xs))} – {usd(Math.max(...xs))}</td></tr>;
              })}
            </tbody>
          </table>
        )}
        <p className="muted">Найменша ціна з прайсу кожного автора. Це опубліковані ціни, а не домовленості: використовуйте як орієнтир для переговорів.</p>
      </section>
    </>
  );
}
