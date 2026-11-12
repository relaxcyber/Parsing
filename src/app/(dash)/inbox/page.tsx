import Link from "next/link";
import { and, desc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db/client";
import { clients, creators, outreachMessages, outreachThreads, type ThreadStatus } from "@/db/schema";
import { THREAD_LABELS } from "../creators/labels";
import { AutoRefresh } from "../search/auto-refresh";

const df = new Intl.DateTimeFormat("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

const draftExists = sql`exists (select 1 from ${outreachMessages} m where m.thread_id = ${outreachThreads.id} and m.direction = 'out' and m.status = 'draft')`;
const TABS: { key: string; label: string; where: SQL | undefined; hint: string }[] = [
  { key: "human", label: "Потрібна людина", where: isNotNull(outreachThreads.needsHuman), hint: "Питання поза правилами, ставка понад стелю, недоставлені листи. Ваша відповідь на питання стає правилом клієнта." },
  { key: "approve", label: "На затвердження", where: draftExists, hint: "Листи, які ІІ підготував, але не надсилає без вас (режим «чекає мого Надіслати» або лист не пройшов перевірку)." },
  { key: "ship", label: "Відправити товар", where: eq(outreachThreads.status, "to_ship"), hint: "Автор погодився й надіслав адресу. Відправте товар і позначте «Відправлено» — далі публікацію перевіряємо самі." },
  { key: "waiting", label: "Чекаємо допис", where: eq(outreachThreads.status, "shipped"), hint: "Товар відправлено: щодня перевіряємо профіль автора на допис із вашими @бренд чи #хештегом." },
  { key: "active", label: "У роботі", where: inArray(outreachThreads.status, ["draft", "sent", "negotiating", "agreed"] satisfies ThreadStatus[]), hint: "ІІ веде листування: чекаємо відповіді, торгуємося, узгоджуємо." },
  { key: "done", label: "Завершені", where: inArray(outreachThreads.status, ["posted", "declined", "no_reply", "closed"] satisfies ThreadStatus[]), hint: "" },
];

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ tab?: string; msg?: string }> }) {
  const { tab = "human", msg } = await searchParams;
  const current = TABS.find((t) => t.key === tab) ?? TABS[0];
  const db = getDb();
  const counts = await Promise.all(TABS.map((t) => db.select({ n: sql<number>`count(*)::int` }).from(outreachThreads).where(t.where).then((r) => r[0]?.n ?? 0)));
  const rows = await db.select({ t: outreachThreads, username: creators.username, client: clients.name }).from(outreachThreads)
    .innerJoin(creators, eq(creators.id, outreachThreads.creatorId)).innerJoin(clients, eq(clients.id, outreachThreads.clientId))
    .where(and(current.where)).orderBy(desc(outreachThreads.updatedAt)).limit(200);
  const busy = rows.some(({ t }) => t.status === "draft" && !t.needsHuman);

  return (
    <>
      {busy && <AutoRefresh everyMs={8000} />}
      <h1>Листування</h1>
      <p className="sub">ІІ пише авторам, відповідає на питання з правил клієнта й торгується в їхніх межах. Сюди потрапляє лише те, що потребує вас.</p>
      {msg && <div className="flash" role="status">{msg}</div>}
      <nav className="tabs">
        {TABS.map((t, i) => (
          <Link key={t.key} href={`/inbox?tab=${t.key}`} className={t.key === current.key ? "on" : undefined}>{t.label} ({counts[i]})</Link>
        ))}
      </nav>
      {current.hint && <p className="muted">{current.hint}</p>}
      <section className="card">
        {rows.length === 0 ? <p className="empty">Тут порожньо.</p> : (
          <div className="scroll">
            <table>
              <thead><tr><th>Автор</th><th>Клієнт</th><th>Стан</th><th>Що потрібно</th><th>Оновлено</th></tr></thead>
              <tbody>
                {rows.map(({ t, username, client }) => (
                  <tr key={t.id}>
                    <td><Link href={`/inbox/${t.id}`}>@{username}</Link><div className="muted">{t.toEmail}</div></td>
                    <td>{client}</td>
                    <td>{THREAD_LABELS[t.status]}{t.terms?.feeUsd ? <div className="muted">${t.terms.feeUsd}</div> : null}</td>
                    <td>{t.needsHuman ? <span className="risk-high">{t.needsHuman}</span> : t.status === "to_ship" ? "відправити товар" : ""}
                      {t.openQuestions.length > 0 && <ul className="plain muted">{t.openQuestions.map((q) => <li key={q}>{q}</li>)}</ul>}</td>
                    <td>{df.format(t.updatedAt)}</td>
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
