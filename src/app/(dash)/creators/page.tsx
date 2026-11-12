import Link from "next/link";
import { and, desc, eq, isNotNull, ne, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { creators } from "@/db/schema";
import { STATUS_LABELS } from "./labels";

const nf = new Intl.NumberFormat("uk-UA", { notation: "compact", maximumFractionDigits: 1 });
const df = new Intl.DateTimeFormat("uk-UA", { day: "2-digit", month: "2-digit" });
const RISK: Record<string, string> = { low: "низький", medium: "середній", high: "високий", unknown: "—" };

const VIEWS = {
  work: { label: "У роботі", where: ne(creators.outreachStatus, "new") },
  yes: { label: "Взяв би", where: eq(creators.manualVerdict, "yes") },
  review: { label: "Перегляньте", where: isNotNull(creators.reviewNote) },
  audited: { label: "Усі оцінені", where: isNotNull(creators.quality) },
} as const;
type View = keyof typeof VIEWS;

export default async function CreatorsPage({ searchParams }: { searchParams: Promise<{ view?: string; status?: string }> }) {
  const sp = await searchParams;
  const view: View = sp.view && sp.view in VIEWS ? (sp.view as View) : "work";
  const status = sp.status && sp.status in STATUS_LABELS ? (sp.status as keyof typeof STATUS_LABELS) : null;
  const db = getDb();
  const [rows, counts] = await Promise.all([
    db.select().from(creators).where(and(VIEWS[view].where, status ? eq(creators.outreachStatus, status) : undefined))
      .orderBy(desc(sql`coalesce(${creators.outreachAt}, ${creators.updatedAt})`)).limit(300),
    db.select({ s: creators.outreachStatus, n: sql<number>`count(*)::int` }).from(creators).groupBy(creators.outreachStatus),
  ]);
  const count = (s: string) => counts.find((c) => c.s === s)?.n ?? 0;

  return (
    <>
      <h1>Креатори</h1>
      <p className="sub">
        Ваша робота з авторами: кому написали, хто відповів, з ким працюєте. Статус ставиться на картці автора.
        {" "}Написали: {count("contacted")} · відповіли: {count("replied")} · у роботі: {count("in_work")} · відмова: {count("declined")}
      </p>
      <section className="card">
        <div className="tabs">
          {(Object.keys(VIEWS) as View[]).map((v) => (
            <Link key={v} href={`/creators?view=${v}`} className={v === view ? "on" : undefined} aria-current={v === view ? "page" : undefined}>{VIEWS[v].label}</Link>
          ))}
        </div>
        {view === "work" && (
          <p className="muted" style={{ marginTop: 0 }}>
            Фільтр: <Link href="/creators?view=work">усі</Link>
            {(["contacted", "replied", "in_work", "declined"] as const).map((s) => <span key={s}> · <Link href={`/creators?view=work&status=${s}`}>{STATUS_LABELS[s]}</Link></span>)}
          </p>
        )}
        {rows.length === 0 ? <div className="empty">Тут поки нікого.</div> : (
          <div className="scroll">
            <table>
              <thead><tr><th>Автор</th><th>Статус</th><th className="num">Підписників</th><th className="num">Якість</th><th>Ризик накрутки</th><th>Email</th><th>Нотатка</th><th>Оновлено</th></tr></thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td><Link href={`/creators/${c.id}`}><b>@{c.username}</b></Link><div className="muted">{c.displayName}</div></td>
                    <td>{STATUS_LABELS[c.outreachStatus]}{c.manualVerdict ? <div className="muted">ваш вердикт: {c.manualVerdict === "yes" ? "взяв би" : "ні"}</div> : null}</td>
                    <td className="num">{c.followers != null ? nf.format(c.followers) : "—"}</td>
                    <td className="num">{c.quality != null ? Math.round(c.quality) : "—"}</td>
                    <td className={`risk-${c.trustRisk ?? "unknown"}`}>{RISK[c.trustRisk ?? "unknown"]}</td>
                    <td className="muted" style={{ overflowWrap: "anywhere", maxWidth: 200 }}>{c.emails[0] ?? "—"}</td>
                    <td className="muted" style={{ maxWidth: 220 }}>{c.outreachNote ?? c.reviewNote ?? ""}</td>
                    <td className="muted">{df.format(c.outreachAt ?? c.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
