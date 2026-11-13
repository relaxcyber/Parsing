import Link from "next/link";
import { notFound } from "next/navigation";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { orders, searches, type OrderSpec } from "@/db/schema";
import { AUTO_START_USD, FIELDS, known, orderResults, orderState, refreshOrder, searchBudget, type FieldKey } from "@/orders";
import { CopyButton } from "../../creators/print-button";
import { ConfirmButton } from "../../keys/confirm-button";
import { AutoRefresh } from "../../search/auto-refresh";
import { STATUS } from "../../search/labels";
import {
  clientMessageAction, deleteOrderAction, deliveryAction, notesAction, orderStatusAction, outreachClientAction, sentAction, startSearchAction,
} from "../actions";
import { ORDER_STATUS } from "../labels";

const df = new Intl.DateTimeFormat("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const PLATFORM = { instagram: "Instagram", tiktok: "TikTok", both: "Instagram і TikTok" } as const;
const n = (v: number | null) => (v == null ? "…" : v.toLocaleString("uk-UA"));

function value(spec: OrderSpec, key: FieldKey): string {
  switch (key) {
    case "niche": return spec.niche ?? "";
    case "platform": return spec.platform ? PLATFORM[spec.platform] : "";
    case "count": return spec.count != null ? String(spec.count) : "";
    case "countries": return spec.countries === "any" ? "будь-які" : (spec.countries ?? []).join(", ");
    case "followers": return `${n(spec.followersMin)} – ${n(spec.followersMax)}`;
    case "deliverable": return spec.deliverable ?? "";
    case "deadline": return spec.deadline ?? "";
    case "wantsOutreach": return spec.wantsOutreach ? "так — листуватися з авторами" : "ні, лише список";
  }
}

export default async function OrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const { msg } = await searchParams;
  const db = getDb();
  const [raw] = await db.select().from(orders).where(eq(orders.id, id));
  if (!raw) notFound();
  const o = await refreshOrder(db, raw);
  const spec = o.spec;
  const st = ORDER_STATUS[o.status];
  const state = orderState(spec, o.asked);
  const runs = o.searchIds.length ? await db.select().from(searches).where(inArray(searches.id, o.searchIds)) : [];
  const results = o.searchIds.length ? await orderResults(db, o.searchIds) : [];
  const searching = runs.some((s) => s.status === "queued" || s.status === "running");
  const lastClient = [...o.messages].reverse().find((m) => m.from === "client");

  return (
    <>
      {searching && <AutoRefresh everyMs={8000} />}
      <h1>{o.title}</h1>
      <p className="sub">
        <Link href="/orders">← Усі замовлення</Link> · <span className={st.cls}>{st.label}</span>
        {o.pitchId && <> · <Link href={`/pitch/${o.pitchId}`}>відгук</Link></>}
      </p>
      {msg && <div className="flash" role="status">{msg}</div>}
      {st.next && <div className="flash"><b>Що зараз:</b> {o.draft && o.status !== "needs_you" ? "скопіюйте відповідь, надішліть клієнту й натисніть «Надіслав»" : st.next}</div>}

      {o.pending.length > 0 && (
        <section className="card">
          <h2 className="risk-high">Клієнт питає — ІІ не знає відповіді</h2>
          <ul>{o.pending.map((q) => <li key={q.quote}><b>{q.questionUk}</b> <span className="muted">(«{q.quote}»)</span></li>)}</ul>
          <p className="muted">Напишіть відповіді в підказках нижче (можна українською, коротко) — ІІ перекладе й вставить у відповідь.</p>
        </section>
      )}

      {o.draft && (
        <section className="card">
          <h2>Відповідь клієнту{o.draftKind === "confirm" ? ": підтвердження й старт" : o.draftKind === "deliver" ? ": результат" : ""}</h2>
          {o.draftIssues.length > 0 && <div className="flash risk-high">Перевірка: {o.draftIssues.join("; ")}. Виправте текст перед відправкою.</div>}
          <form action={sentAction} className="search-form">
            <input type="hidden" name="id" value={o.id} />
            <label className="wide">Текст (можна правити)<textarea name="text" rows={10} defaultValue={o.draft} /></label>
            <div className="inline">
              <CopyButton text={o.draft} label="Копіювати" />
              <button className="primary">Надіслав клієнту</button>
            </div>
          </form>
          {o.draftUk && (
            <details style={{ marginTop: 8 }}>
              <summary>Переклад українською</summary>
              <p style={{ whiteSpace: "pre-wrap" }}>{o.draftUk}</p>
            </details>
          )}
          {o.draftKind === "confirm" && (
            <p className="muted">
              {spec && searchBudget(spec) > AUTO_START_USD
                ? `Пошук може коштувати до $${searchBudget(spec)}, тому після «Надіслав» запустіть його кнопкою в «Завданні на пошук».`
                : "Після «Надіслав» пошук запуститься сам."}
            </p>
          )}
          {o.draftKind === "deliver" && runs.length > 0 && (
            <p className="muted">Прикладіть файл: {runs.map((s) => <a key={s.id} href={`/search/${s.id}/export`} style={{ marginRight: 8 }}>CSV {s.platform === "tiktok" ? "TikTok" : "Instagram"}</a>)}</p>
          )}
        </section>
      )}

      <section className="card">
        <h2>Нове повідомлення клієнта</h2>
        {lastClient && spec?.lastMessageUk && (
          <details style={{ marginBottom: 8 }}>
            <summary>Останнє повідомлення клієнта українською</summary>
            <p style={{ whiteSpace: "pre-wrap" }}>{spec.lastMessageUk}</p>
          </details>
        )}
        <form action={clientMessageAction} className="search-form">
          <input type="hidden" name="id" value={o.id} />
          <label className="wide">Вставте, що написав клієнт<textarea name="text" rows={4} required maxLength={8000} /></label>
          <button className="primary">Розібрати й написати відповідь</button>
        </form>
      </section>

      <section className="card">
        <h2>Ваші підказки для ІІ</h2>
        <form action={notesAction} className="search-form">
          <input type="hidden" name="id" value={o.id} />
          <label className="wide">
            Що можна казати клієнту, кожна думка з нового рядка (можна українською): ціна, строк, відповіді на його питання
            <textarea name="notes" rows={4} maxLength={2000} defaultValue={o.notes ?? ""} placeholder={"список зроблю за 3 дні\nемейли додаю, якщо вони є в профілі"} />
          </label>
          <button>Зберегти й переписати відповідь</button>
        </form>
      </section>

      {spec && (
        <section className="card">
          <h2>Завдання на пошук</h2>
          <p>{spec.summaryUk}</p>
          <table>
            <tbody>
              {spec.brand && <tr><th>Бренд</th><td>{spec.brand}{spec.website ? ` · ${spec.website}` : ""}</td><td></td></tr>}
              {FIELDS.map((f) => {
                const ok = known(spec, f.key);
                const asking = !ok && state.toAsk.includes(f.key);
                return (
                  <tr key={f.key}>
                    <th>{f.label}{f.required ? " *" : ""}</th>
                    <td>{ok ? value(spec, f.key) : asking ? <span className="risk-medium">питаємо клієнта</span> : <span className="muted">типове: {f.fallback}</span>}</td>
                    <td className="muted">{ok && spec.quotes[f.key] ? `«${spec.quotes[f.key]}»` : ""}</td>
                  </tr>
                );
              })}
              {spec.mustHave.length > 0 && <tr><th>Обов’язково</th><td colSpan={2}>{spec.mustHave.join("; ")}</td></tr>}
              {spec.exclude.length > 0 && <tr><th>Не брати</th><td colSpan={2}>{spec.exclude.join("; ")}</td></tr>}
              {spec.budget && <tr><th>Бюджет</th><td>${spec.budget.amount}{spec.budget.kind === "hourly" ? "/год" : ""}</td><td className="muted">{spec.quotes.budget ? `«${spec.quotes.budget}»` : ""}</td></tr>}
            </tbody>
          </table>
          <p className="muted">* без цього пошук не запуститься. Необов’язкове ІІ питає один раз; не відповіли — береться типове. Значення беруться лише з дослівних слів клієнта{spec.dropped ? ` (відкинуто без цитати: ${spec.dropped})` : ""}.</p>
          <div className="inline">
            {state.ready && runs.length === 0 && (
              <form action={startSearchAction}><input type="hidden" name="id" value={o.id} /><button className="primary">Запустити пошук{spec.platform !== "tiktok" ? ` (до $${searchBudget(spec)})` : ""}</button></form>
            )}
            {state.ready && runs.length > 0 && (
              <form action={startSearchAction}><input type="hidden" name="id" value={o.id} /><input type="hidden" name="restart" value="1" /><button className="chip">Перезапустити пошук з новим завданням</button></form>
            )}
            {spec.wantsOutreach && (
              o.clientId ? <Link href={`/clients/${o.clientId}`} className="chip">Клієнт для листування з авторами →</Link>
                : <form action={outreachClientAction}><input type="hidden" name="id" value={o.id} /><button className="chip">Створити клієнта для листування з авторами</button></form>
            )}
          </div>
        </section>
      )}

      {runs.length > 0 && (
        <section className="card">
          <h2>Пошук і результат</h2>
          <table>
            <thead><tr><th>Пошук</th><th>Стан</th><th className="num">Підходять</th><th className="num">З email</th><th>Файл</th></tr></thead>
            <tbody>
              {runs.map((s) => {
                const r = results.find((x) => x.platform === s.platform);
                return (
                  <tr key={s.id}>
                    <td><Link href={`/search/${s.id}`}>{s.name}</Link></td>
                    <td style={{ color: STATUS[s.status].color }}>{STATUS[s.status].label}{s.progress && (s.status === "running") ? ` · ${s.progress.stage} ${s.progress.done}/${s.progress.total}` : ""}</td>
                    <td className="num">{r?.found ?? 0}{spec?.count ? ` / ${spec.count}` : ""}</td>
                    <td className="num">{r?.with_email ?? 0}</td>
                    <td><a href={`/search/${s.id}/export`}>CSV</a> · <Link href={`/search/${s.id}/report`}>звіт</Link></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {(o.status === "results" || o.status === "delivered") && (
            <form action={deliveryAction} style={{ marginTop: 12 }}>
              <input type="hidden" name="id" value={o.id} />
              <button className="primary">Написати повідомлення з результатом</button>
            </form>
          )}
          <p className="muted">Перед відправкою відкрийте CSV і гляньте 5–10 авторів: прибрати невдалих швидше, ніж пояснювати клієнту.</p>
        </section>
      )}

      <section className="card">
        <h2>Переписка</h2>
        {o.messages.map((m, i) => (
          <div key={i} style={{ borderLeft: `3px solid ${m.from === "client" ? "var(--ink-3)" : "var(--good)"}`, padding: "4px 10px", margin: "8px 0" }}>
            <div className="muted">{m.from === "client" ? "Клієнт" : "Ви"} · {df.format(new Date(m.at))}</div>
            <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
          </div>
        ))}
        <details>
          <summary>Записати повідомлення, яке ви написали самі</summary>
          <form action={sentAction} className="search-form">
            <input type="hidden" name="id" value={o.id} />
            <input type="hidden" name="manual" value="1" />
            <textarea name="text" rows={3} required maxLength={8000} />
            <button>Записати</button>
          </form>
        </details>
      </section>

      <div className="inline">
        {o.status !== "closed" && (
          <form action={orderStatusAction}><input type="hidden" name="id" value={o.id} /><input type="hidden" name="status" value="closed" /><button className="chip">Закрити замовлення</button></form>
        )}
        <form action={deleteOrderAction}>
          <input type="hidden" name="id" value={o.id} />
          <ConfirmButton question="Видалити замовлення з перепискою?">Видалити</ConfirmButton>
        </form>
      </div>
    </>
  );
}
