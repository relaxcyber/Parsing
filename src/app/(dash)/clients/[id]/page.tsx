import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { clients, creators, mailboxes, outreachThreads, searches } from "@/db/schema";
import { clientReport } from "@/outreach/engine";
import { policyOf } from "@/outreach/policy";
import { ConfirmButton } from "../../keys/confirm-button";
import { PrintButton } from "../../creators/print-button";
import { THREAD_LABELS } from "../../creators/labels";
import { deleteClient, deleteFaq, saveClient } from "../actions";

const df = new Intl.DateTimeFormat("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric" });
const usd = (n: number | null | undefined) => (n == null ? "—" : `$${n.toFixed(2).replace(".", ",")}`);
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");

export default async function ClientPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string }> }) {
  const id = Number((await params).id);
  const { msg } = await searchParams;
  if (!Number.isInteger(id)) notFound();
  const db = getDb();
  const [c] = await db.select().from(clients).where(eq(clients.id, id));
  if (!c) notFound();
  const p = policyOf(c.policy);
  const [boxes, threads, report, clientSearches] = await Promise.all([
    db.select().from(mailboxes).orderBy(asc(mailboxes.email)),
    db.select({ t: outreachThreads, username: creators.username }).from(outreachThreads)
      .innerJoin(creators, eq(creators.id, outreachThreads.creatorId)).where(eq(outreachThreads.clientId, id)).orderBy(desc(outreachThreads.updatedAt)).limit(200),
    clientReport(db, id),
    db.select({ id: searches.id, name: searches.name }).from(searches).where(eq(searches.clientId, id)).orderBy(desc(searches.createdAt)).limit(20),
  ]);

  return (
    <>
      <div className="actions no-print" style={{ float: "right" }}><PrintButton /></div>
      <h1>{c.name}</h1>
      <p className="sub"><Link href="/clients" className="no-print">← Клієнти</Link> · Звіт і правила переговорів.</p>
      {msg && <div className="flash" role="status">{msg}</div>}

      <section className="card">
        <h2>Звіт для клієнта</h2>
        <div className="kv">
          <div><b>{report.contacted}</b><span>написали</span></div>
          <div><b>{report.replied}</b><span>відповіли ({pct(report.replied, report.contacted)})</span></div>
          <div><b>{report.agreed}</b><span>погодились</span></div>
          <div><b>{report.shipped}</b><span>отримали товар</span></div>
          <div><b>{report.posted}</b><span>опублікували</span></div>
          <div><b>{usd(report.costUsd)}</b><span>витрати на пошук</span></div>
          <div><b>{report.posted ? usd((report.costUsd + report.feesUsd) / report.posted) : "—"}</b><span>за допис (пошук + гонорари)</span></div>
          <div><b>{report.autoHandled}</b><span>листів написав ІІ (людина: {report.humanHandled})</span></div>
        </div>
        {report.disclosureMissing > 0 && <p>⚠ Дописів без позначки реклами: <b>{report.disclosureMissing}</b></p>}
        {report.posts.length > 0 && (
          <table style={{ marginTop: 12 }}>
            <thead><tr><th>Автор</th><th>Допис</th><th>Дата</th><th>Позначка реклами</th><th className="num">Гонорар</th></tr></thead>
            <tbody>
              {report.posts.map((x) => (
                <tr key={x.creatorId}>
                  <td><Link href={`/creators/${x.creatorId}`}>@{x.username}</Link></td>
                  <td><a href={x.url} target="_blank" rel="noreferrer">відкрити</a></td>
                  <td>{x.postedAt ? df.format(x.postedAt) : "—"}</td>
                  <td>{x.disclosure == null ? "—" : x.disclosure ? "так" : "⚠ немає"}</td>
                  <td className="num">{x.feeUsd ? usd(x.feeUsd) : "бартер"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {clientSearches.length > 0 && <p className="muted">Пошуки: {clientSearches.map((s, i) => <span key={s.id}>{i ? ", " : ""}<Link href={`/search/${s.id}`}>{s.name}</Link></span>)}</p>}
      </section>

      <section className="card no-print">
        <h2>Листування ({threads.length})</h2>
        {threads.length === 0 ? <p className="muted">Почніть із картки автора («Листування») або на сторінці пошуку кнопкою «Почати листування з лідами».</p> : (
          <div className="scroll">
            <table>
              <thead><tr><th>Автор</th><th>Стан</th><th>Потрібна людина</th><th>Оновлено</th></tr></thead>
              <tbody>
                {threads.map(({ t, username }) => (
                  <tr key={t.id}>
                    <td><Link href={`/inbox/${t.id}`}>@{username}</Link></td>
                    <td>{THREAD_LABELS[t.status]}</td>
                    <td>{t.needsHuman ? <span className="risk-high">{t.needsHuman}</span> : ""}</td>
                    <td>{df.format(t.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card no-print">
        <h2>Правила переговорів</h2>
        <p className="muted">ІІ пише й торгується лише в цих межах. Стелю оплати він автору не називає, поки торг до неї не дійде. Усе, чого тут немає, — питання людині.</p>
        <form action={saveClient} className="search-form">
          <input type="hidden" name="id" value={c.id} />
          <fieldset>
            <legend>Бренд і пропозиція</legend>
            <div className="grid">
              <label>Назва клієнта<input name="name" defaultValue={c.name} required /></label>
              <label>Бренд у листах<input name="brandName" defaultValue={p.brandName} /></label>
              <label>Сайт<input name="website" defaultValue={p.website} placeholder="https://…" /></label>
              <label>Підпис (ім’я відправника)<input name="senderName" defaultValue={p.senderName} placeholder="напр. Anna, Glow Lab" /></label>
            </div>
            <label className="wide">Що пропонуємо (товар, послуга)<textarea name="product" rows={2} defaultValue={p.product} placeholder="напр. сироватка з вітаміном C, 30 мл" /></label>
            <div className="grid">
              <label>
                Формат співпраці
                <select name="offerType" defaultValue={p.offerType}>
                  <option value="barter">лише бартер (товар за контент)</option>
                  <option value="paid">лише оплата</option>
                  <option value="both">товар + оплата</option>
                </select>
              </label>
              <label>Вартість товару, $<input name="productValueUsd" defaultValue={p.productValueUsd ?? ""} inputMode="decimal" /></label>
              <label>Перша пропозиція, $<input name="feeTargetUsd" defaultValue={p.feeTargetUsd ?? ""} inputMode="decimal" placeholder="порожньо — спитати ставку" /></label>
              <label>Стеля оплати, $<input name="feeMaxUsd" defaultValue={p.feeMaxUsd ?? ""} inputMode="decimal" placeholder="понад неї — людині" /></label>
              <label>Раундів торгу<input name="maxRounds" type="number" min={0} max={5} defaultValue={p.maxRounds} /></label>
              <label>
                Якщо просять більше стелі
                <select name="aboveMax" defaultValue={p.aboveMax}>
                  <option value="escalate">спитати мене</option>
                  <option value="decline">ввічливо відмовити</option>
                </select>
              </label>
            </div>
          </fieldset>
          <fieldset>
            <legend>Умови</legend>
            <label className="wide">Що автор робить<textarea name="deliverables" rows={2} defaultValue={p.deliverables} /></label>
            <div className="grid">
              <label>Днів на публікацію після отримання<input name="deadlineDays" type="number" min={1} max={120} defaultValue={p.deadlineDays} /></label>
              <label>Відмітити в дописі (через кому)<input name="mustTag" defaultValue={p.mustTag.join(", ")} placeholder="@glowlab, #glowlabglow" /></label>
              <label>Відправляємо в країни<input name="shipsTo" defaultValue={p.shipsTo.join(", ")} placeholder="US, GB — порожньо: будь-куди" /></label>
            </div>
            <label className="wide">Права на контент<textarea name="usageRights" rows={2} defaultValue={p.usageRights} placeholder="напр. репост на сторінках бренду без обмежень; використання в рекламі — окремо, за домовленістю" /></label>
            <label className="wide">Позначка реклами<input name="disclosure" defaultValue={p.disclosure} /></label>
            <label className="wide">Інші правила словами<textarea name="notes" rows={3} defaultValue={p.notes} placeholder="напр. оплата після публікації, через PayPal; ексклюзивність не вимагаємо; повторна співпраця можлива" /></label>
          </fieldset>
          <fieldset>
            <legend>Листування</legend>
            <div className="grid">
              <label>
                Скринька
                <select name="mailboxId" defaultValue={c.mailboxId ?? ""}>
                  <option value="">— не вибрано —</option>
                  {boxes.map((b) => <option key={b.id} value={b.id}>{b.email}</option>)}
                </select>
              </label>
              <label>
                Режим
                <select name="mode" defaultValue={p.mode}>
                  <option value="approve">кожен лист чекає мого «Надіслати»</option>
                  <option value="auto">ІІ надсилає перевірені листи сам</option>
                </select>
              </label>
              <label>Нагадати через, днів<input name="followupDays" type="number" min={1} max={30} defaultValue={p.followupDays} /></label>
            </div>
            {boxes.length === 0 && <p className="muted">Спершу <Link href="/clients#mailboxes">підключіть скриньку</Link>.</p>}
            <p className="muted">Почніть з режиму «чекає мого Надіслати»: перегляньте 10–20 листів ІІ, і коли вони вас влаштовують — увімкніть автоматичний.</p>
          </fieldset>
          <div className="actions"><button className="primary">Зберегти правила</button></div>
        </form>
      </section>

      <section className="card no-print">
        <h2>Відповіді, яких навчився ІІ ({p.faq.length})</h2>
        {p.faq.length === 0 ? <p className="muted">Коли автор питає те, чого немає в правилах, питання приходить вам, а ваша відповідь з’являється тут — далі ІІ відповідає на таке сам.</p> : (
          <ul className="plain">
            {p.faq.map((f, i) => (
              <li key={i}>
                <b>{f.q}</b> — {f.a}
                <form action={deleteFaq} style={{ display: "inline" }}>
                  <input type="hidden" name="id" value={c.id} /><input type="hidden" name="index" value={i} />
                  <button className="link danger">прибрати</button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      <form action={deleteClient} className="no-print">
        <input type="hidden" name="id" value={c.id} />
        <ConfirmButton question={`Видалити клієнта ${c.name} разом з усім листуванням?`}>Видалити клієнта</ConfirmButton>
      </form>
    </>
  );
}
