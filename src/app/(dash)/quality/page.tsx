import Link from "next/link";
import { redirect } from "next/navigation";
import { desc, isNotNull, sql } from "drizzle-orm";
import { AUDIT_VERSION } from "@/audit/vision";
import { getDb } from "@/db/client";
import { creators, evalRuns } from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import { calibrate } from "@/search/calibrate";
import { DEFAULT_CRITERIA } from "@/search/criteria";
import { evalRunning, runEval } from "@/search/evaluate";
import { AutoRefresh } from "../search/auto-refresh";

const df = new Intl.DateTimeFormat("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

async function startEval() {
  "use server";
  await requireAuth();
  // У фоні: оцінка кількох десятків колажів займає хвилини.
  void runEval(getDb()).catch((e) => console.error("Перевірка точності не вдалася:", e));
  redirect("/quality?started=1");
}

export default async function QualityPage({ searchParams }: { searchParams: Promise<{ started?: string }> }) {
  const { started } = await searchParams;
  const db = getDb();
  const lead = DEFAULT_CRITERIA.quality.lead;
  const [labeled, runs, byVersion] = await Promise.all([
    db.select({ quality: creators.quality, verdict: creators.manualVerdict }).from(creators).where(sql`${creators.manualVerdict} is not null and ${creators.quality} is not null`),
    db.select().from(evalRuns).orderBy(desc(evalRuns.createdAt)).limit(10),
    db.select({ v: creators.auditVersion, verdict: creators.manualVerdict, quality: creators.quality }).from(creators)
      .where(sql`${creators.manualVerdict} is not null and ${creators.quality} is not null`),
  ]);
  const [{ n: verdicts }] = await db.select({ n: sql<number>`count(*)::int` }).from(creators).where(isNotNull(creators.manualVerdict));
  const cal = calibrate(labeled.map((l) => ({ quality: l.quality!, verdict: l.verdict! })), lead);
  const versions = [...new Set(byVersion.map((r) => r.v ?? "vision-v1"))];
  const running = evalRunning();

  return (
    <>
      {running && <AutoRefresh everyMs={5000} />}
      <h1>Точність оцінок</h1>
      <p className="sub">
        Ваші вердикти «Взяв би / Ні» — еталон. Тут видно, як часто оцінка якості збігається з вашим рішенням, і чи нова версія промпту краща за попередню.
      </p>
      {started && !running && <div className="flash" role="status">Перевірку завершено — результат у таблиці нижче.</div>}
      {running && <div className="flash" role="status">Перевірка виконується у фоні…</div>}

      <section className="card">
        <h2>Зараз</h2>
        <p>
          Вердиктів: <b>{verdicts}</b>, з них з оцінкою якості: <b>{cal.labeled}</b>.
          {cal.labeled > 0 && <> За порога ліда {lead} модель згодна з вами у <b>{cal.current.agree}</b> з {cal.labeled} ({Math.round((cal.current.agree / cal.labeled) * 100)}%).</>}
          {cal.best && cal.best.threshold !== lead && <> Найкращий збіг дає поріг <b>{cal.best.threshold}</b> ({cal.best.agree} з {cal.labeled}) — його можна задати в критеріях пошуку.</>}
        </p>
        {cal.labeled < 30 && <p className="muted">Для надійного висновку потрібно 30–50 вердиктів обох типів. Розмічайте авторів на сторінці пошуку чи в картці.</p>}
        {versions.length > 1 && (
          <table>
            <thead><tr><th>Версія аудиту</th><th className="num">Розмічено</th><th className="num">Збіг з вами</th></tr></thead>
            <tbody>
              {versions.map((v) => {
                const rows = byVersion.filter((r) => (r.v ?? "vision-v1") === v);
                const agree = rows.filter((r) => (r.quality! >= lead) === (r.verdict === "yes")).length;
                return <tr key={v}><td>{v}</td><td className="num">{rows.length}</td><td className="num">{rows.length ? `${Math.round((agree / rows.length) * 100)}%` : "—"}</td></tr>;
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Переоцінка поточною версією ({AUDIT_VERSION})</h2>
        <p className="muted">
          Збережені колажі всіх розмічених авторів оцінюються поточним промптом; Instagram не запитується. Однакові запити беруться з кешу,
          тож повтор без змін промпту безкоштовний. Витрачає ліміт мовної моделі: один запит на автора.
        </p>
        <form action={startEval}><button className="primary" disabled={running || verdicts === 0}>Переоцінити розмічених</button></form>
        {runs.length > 0 && (
          <div className="scroll">
            <table style={{ marginTop: 12 }}>
              <thead><tr><th>Коли</th><th>Версія</th><th className="num">Оцінено</th><th className="num">Збіг з вами</th><th className="num">Поріг</th></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td>{df.format(r.createdAt)}</td><td>{r.version}</td><td className="num">{r.total}</td>
                    <td className="num">{r.total ? `${r.agree} (${Math.round((r.agree / r.total) * 100)}%)` : "—"}</td><td className="num">{r.threshold}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="muted"><Link href="/help">Що означають оцінки</Link></p>
    </>
  );
}
