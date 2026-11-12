import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { clients, creators, mailboxes, outreachMessages, outreachThreads } from "@/db/schema";
import type { Decision, Plan, ReplyAnalysis } from "@/outreach/negotiate";
import { policyOf } from "@/outreach/policy";
import { signature } from "@/outreach/engine";
import { THREAD_LABELS } from "../../creators/labels";
import { AutoRefresh } from "../../search/auto-refresh";
import {
  allowFeeAction, answer, approve, checkPostAction, discard, manualReplyAction, postedAction, reprocessAction, resolveAction, shippedAction, statusAction,
} from "../actions";

const df = new Intl.DateTimeFormat("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const KIND = { first: "перший лист", reply: "відповідь ІІ", followup: "нагадування", manual: "ваш лист", inbound: "автор" } as const;
const MSG_STATUS = { draft: "чернетка", queued: "у черзі", sent: "надіслано", failed: "не надіслано", received: "отримано", discarded: "відхилено" } as const;

function Analysis({ a, d }: { a: ReplyAnalysis | null; d: Decision | null }) {
  if (!a && !d) return null;
  const flags = a ? [
    a.interested && "зацікавлений", a.agrees && "погоджується", a.declines && "відмовляється", a.unsubscribe && "просить не писати",
    a.outOfOffice && "автовідповідь", a.rate && `ставка: ${a.rate.amount} ${a.rate.currency ?? ""}`, a.address && "надіслав адресу",
  ].filter(Boolean) : [];
  return (
    <div className="muted" style={{ marginTop: 6 }}>
      {a?.summary && <div>Розбір ІІ: {a.summary}</div>}
      {flags.length > 0 && <div>Знайдено: {flags.join(" · ")}</div>}
      {a?.questions.length ? <div>Питання: {a.questions.map((q) => q.question).join("; ")}</div> : null}
      {a && a.dropped > 0 && <div>Відкинуто тверджень без цитати: {a.dropped}</div>}
      {d && <div>Рішення: <b>{d.action === "reply" ? d.why : d.action === "escalate" ? `людині — ${d.reason}` : d.action === "close" ? `закрити — ${d.why}` : `зачекати — ${d.why}`}</b></div>}
    </div>
  );
}

export default async function ThreadPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string }> }) {
  const id = Number((await params).id);
  const { msg } = await searchParams;
  if (!Number.isInteger(id)) notFound();
  const db = getDb();
  const [t] = await db.select().from(outreachThreads).where(eq(outreachThreads.id, id));
  if (!t) notFound();
  const [[c], [client], messages] = await Promise.all([
    db.select().from(creators).where(eq(creators.id, t.creatorId)),
    db.select().from(clients).where(eq(clients.id, t.clientId)),
    db.select().from(outreachMessages).where(eq(outreachMessages.threadId, id)).orderBy(asc(outreachMessages.createdAt)),
  ]);
  const [mb] = t.mailboxId ? await db.select().from(mailboxes).where(eq(mailboxes.id, t.mailboxId)) : [];
  const policy = policyOf(client?.policy);
  const visible = messages.filter((m) => m.status !== "discarded");
  const hidden = messages.length - visible.length;
  const generating = t.status === "draft" && !t.needsHuman && !visible.some((m) => m.direction === "out");
  const hidden_ = <input type="hidden" name="threadId" value={t.id} />;

  return (
    <>
      {(generating || visible.some((m) => m.status === "queued")) && <AutoRefresh everyMs={6000} />}
      <h1>@{c?.username} · {client?.name}</h1>
      <p className="sub">
        <Link href="/inbox">← Листування</Link> · {t.toEmail} · <b>{THREAD_LABELS[t.status]}</b>
        {t.terms && <> · умови: {t.terms.feeUsd ? `$${t.terms.feeUsd}` : "без оплати"}{t.terms.barter ? " + товар" : ""}</>}
        {t.rounds > 0 && <> · раундів торгу: {t.rounds}</>}
        {c && <> · <Link href={`/creators/${c.id}`}>картка автора</Link></>}
        {client && <> · <Link href={`/clients/${client.id}`}>правила клієнта</Link></>}
      </p>
      {msg && <div className="flash" role="status">{msg}</div>}

      {t.needsHuman && (
        <section className="card" style={{ borderColor: "var(--critical)" }}>
          <h2>Потрібна ваша відповідь</h2>
          <p>{t.needsHuman}</p>
          {t.openQuestions.length > 0 && (
            <form action={answer} className="stack">
              {hidden_}
              <p className="muted">Відповідь збережеться в правилах клієнта, і ІІ одразу напише автору. Наступного разу на таке питання він відповість сам.</p>
              {t.openQuestions.map((q) => (
                <label key={q}>{q}<input type="hidden" name="q" value={q} /><textarea name="a" rows={2} placeholder="Ваша відповідь (факт або правило)" style={{ fontFamily: "inherit", fontSize: 14 }} /></label>
              ))}
              <div className="actions"><button className="primary">Зберегти й відповісти автору</button></div>
            </form>
          )}
          {t.askedFeeUsd != null && (
            <form action={allowFeeAction} className="inline" style={{ maxWidth: 520, marginTop: 10 }}>
              {hidden_}
              <input name="fee" defaultValue={t.askedFeeUsd} inputMode="decimal" aria-label="Ставка, $" />
              <button>Дозволити цю ставку, $</button>
            </form>
          )}
          <div className="actions" style={{ marginTop: 10 }}>
            <form action={reprocessAction}>{hidden_}<button>Розібрати наново (після зміни правил)</button></form>
            <form action={resolveAction}>{hidden_}<button className="link">Зняти позначку</button></form>
          </div>
        </section>
      )}

      {generating && <div className="flash" role="status">ІІ пише перший лист…</div>}

      <section className="card">
        <h2>Листи</h2>
        {visible.length === 0 && !generating && <p className="muted">Листів ще немає.</p>}
        {visible.map((m) => {
          const ai = (m.ai ?? {}) as { analysis?: ReplyAnalysis | null; decision?: Decision | null; plan?: Plan; why?: string; subjectB?: string };
          return (
            <div key={m.id} style={{ borderTop: "1px solid var(--line)", padding: "10px 0" }}>
              <div className="muted">
                <b>{KIND[m.kind]}</b> · {MSG_STATUS[m.status]} · {df.format(m.sentAt ?? m.receivedAt ?? m.createdAt)}
                {m.direction === "out" && ai.why && <> · {ai.why}</>}
              </div>
              {m.issues.length > 0 && <ul className="plain">{m.issues.map((x) => <li key={x}>⚠ {x}</li>)}</ul>}
              {m.error && <p className="err">⚠ {m.error}</p>}
              {m.status === "draft" || m.status === "failed" ? (
                <form action={approve} className="stack">
                  {hidden_}<input type="hidden" name="id" value={m.id} />
                  {m.kind === "first" && <label>Тема<input name="subject" defaultValue={m.subject} />{ai.subjectB && <span className="muted">Інший варіант: {ai.subjectB}</span>}</label>}
                  <textarea name="body" rows={Math.min(16, m.body.split("\n").length + 3)} defaultValue={signature(m.body, policy, mb)} style={{ fontFamily: "inherit", fontSize: 14 }} />
                  <div className="actions">
                    <button className="primary">Надіслати</button>
                    <button formAction={discard} className="link danger">Відхилити</button>
                  </div>
                </form>
              ) : (
                <pre className="draft">{m.direction === "out" ? signature(m.body, policy, mb) : m.body}</pre>
              )}
              {m.direction === "in" && <Analysis a={ai.analysis ?? null} d={ai.decision ?? null} />}
            </div>
          );
        })}
        {hidden > 0 && <p className="muted">Відхилених чернеток: {hidden}</p>}
      </section>

      <div className="two">
        <section className="card">
          <h2>Написати самому</h2>
          <form action={manualReplyAction} className="stack">
            {hidden_}
            <textarea name="body" rows={5} placeholder="Лист піде з тієї самої скриньки в цей ланцюжок" style={{ fontFamily: "inherit", fontSize: 14 }} />
            <div className="actions"><button>Надіслати</button></div>
          </form>
        </section>
        <section className="card">
          <h2>Етап</h2>
          {t.shipping && <><p className="muted">Адреса доставки:</p><pre className="draft">{t.shipping}</pre></>}
          {t.postUrl && <p>Допис: <a href={t.postUrl} target="_blank" rel="noreferrer">{t.postUrl}</a>{t.postCheck?.disclosure === false ? " · ⚠ без позначки реклами" : ""}</p>}
          {t.postCheck && !t.postUrl && <p className="muted">Перевірка {df.format(new Date(t.postCheck.checkedAt))}: {t.postCheck.note}</p>}
          {t.postDueAt && t.status === "shipped" && <p className="muted">Строк публікації: {df.format(t.postDueAt)}</p>}
          <div className="actions">
            {(t.status === "to_ship" || t.status === "agreed") && <form action={shippedAction}>{hidden_}<button className="primary">Товар відправлено</button></form>}
            {t.status === "shipped" && <form action={checkPostAction}>{hidden_}<button>Перевірити допис зараз</button></form>}
            {t.status !== "posted" && <form action={statusAction}>{hidden_}<input type="hidden" name="status" value="declined" /><button className="link">Відмова</button></form>}
            {t.status !== "closed" && <form action={statusAction}>{hidden_}<input type="hidden" name="status" value="closed" /><button className="link">Закрити</button></form>}
          </div>
          {t.status !== "posted" && (
            <form action={postedAction} className="inline" style={{ marginTop: 10 }}>
              {hidden_}<input name="url" placeholder="Посилання на допис" aria-label="Посилання на допис" /><button>Зарахувати допис</button>
            </form>
          )}
        </section>
      </div>
    </>
  );
}
