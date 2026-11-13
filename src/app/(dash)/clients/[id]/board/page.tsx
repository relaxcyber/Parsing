import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { clients, creators, outreachThreads, type ThreadStatus } from "@/db/schema";
import { checkPostAction, shippedAction } from "../../../inbox/actions";

/** Етапи дошки: кожне листування — картка в колонці свого етапу. */
const COLUMNS: { title: string; statuses: ThreadStatus[]; hint: string }[] = [
  { title: "Готується", statuses: ["draft"], hint: "ІІ пише перший лист" },
  { title: "Написали", statuses: ["sent"], hint: "чекаємо відповіді, нагадування — самі" },
  { title: "Переговори", statuses: ["negotiating"], hint: "ІІ торгується в межах правил" },
  { title: "Узгоджено", statuses: ["agreed", "to_ship"], hint: "чекаємо адресу чи відправку товару" },
  { title: "Чекаємо допис", statuses: ["shipped"], hint: "профіль перевіряється сам" },
  { title: "Опубліковано", statuses: ["posted"], hint: "" },
  { title: "Закриті", statuses: ["declined", "no_reply", "closed"], hint: "відмова, без відповіді" },
];

const days = (d: Date) => Math.max(0, Math.floor((Date.now() - d.getTime()) / 86_400_000));

export default async function Board({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const db = getDb();
  const [c] = await db.select().from(clients).where(eq(clients.id, id));
  if (!c) notFound();
  const rows = await db.select({ t: outreachThreads, username: creators.username, followers: creators.followers, platform: creators.platform })
    .from(outreachThreads).innerJoin(creators, eq(creators.id, outreachThreads.creatorId))
    .where(eq(outreachThreads.clientId, id)).orderBy(desc(outreachThreads.updatedAt)).limit(500);
  const human = rows.filter(({ t }) => t.needsHuman).length;

  return (
    <>
      <h1>{c.name}: дошка</h1>
      <p className="sub">
        <Link href={`/clients/${c.id}`}>← Клієнт</Link> · листувань: {rows.length}
        {human > 0 && <> · <Link href="/inbox?tab=human" className="risk-high">потрібна людина: {human}</Link></>}
      </p>
      <div className="board">
        {COLUMNS.map((col) => {
          const cards = rows.filter(({ t }) => col.statuses.includes(t.status));
          return (
            <section key={col.title} className="board-col">
              <h2>{col.title} <span className="muted">{cards.length}</span></h2>
              {col.hint && <p className="muted" style={{ margin: "0 0 8px" }}>{col.hint}</p>}
              {cards.map(({ t, username, followers, platform }) => (
                <div key={t.id} className={`board-card${t.needsHuman ? " attention" : ""}`}>
                  <Link href={`/inbox/${t.id}`}><b>@{username}</b></Link>
                  <div className="muted">
                    {platform === "tiktok" ? "TikTok · " : ""}{followers != null ? `${followers.toLocaleString("uk-UA")} підп. · ` : ""}
                    {t.terms?.feeUsd ? `$${t.terms.feeUsd} · ` : t.terms ? "бартер · " : ""}{days(t.updatedAt)} дн. тому
                  </div>
                  {t.needsHuman && <div className="risk-high" style={{ fontSize: 12 }}>{t.needsHuman}</div>}
                  {t.status === "to_ship" && (
                    <form action={shippedAction}><input type="hidden" name="threadId" value={t.id} /><button className="chip">Товар відправлено</button></form>
                  )}
                  {t.status === "shipped" && (
                    <form action={checkPostAction}><input type="hidden" name="threadId" value={t.id} /><button className="chip">Перевірити допис</button></form>
                  )}
                  {t.status === "posted" && t.postUrl && <a href={t.postUrl} target="_blank" rel="noreferrer" className="muted">допис ↗</a>}
                </div>
              ))}
            </section>
          );
        })}
      </div>
    </>
  );
}
