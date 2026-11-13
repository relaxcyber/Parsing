import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { jobPitches, searches } from "@/db/schema";
import { jobFit, SAMPLE_COUNT, sampleList, sampleOptions } from "@/pitch";
import { CopyButton } from "../../creators/print-button";
import { ConfirmButton } from "../../keys/confirm-button";
import { AutoRefresh } from "../../search/auto-refresh";
import { STATUS } from "../../search/labels";
import { fromPitchAction } from "../../orders/actions";
import { deletePitchAction, pitchStatusAction, rewriteAction, saveProposalAction } from "../actions";
import { FIT, JOB_TYPE, PITCH_STATUS } from "../labels";

const PLATFORM = { instagram: "Instagram", tiktok: "TikTok", both: "Instagram і TikTok", unknown: "не вказано" } as const;

export default async function PitchDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const { msg } = await searchParams;
  const db = getDb();
  const [p] = await db.select().from(jobPitches).where(eq(jobPitches.id, id));
  if (!p) notFound();
  const [s] = p.searchId ? await db.select().from(searches).where(eq(searches.id, p.searchId)) : [];
  const options = s ? await sampleOptions(db, s.id, 15, p.analysis?.followers) : [];
  const a = p.analysis;
  const fit = a ? jobFit(a) : null;
  const chosen = new Set(p.samples.length ? p.samples.map((x) => x.creatorId) : options.slice(0, SAMPLE_COUNT).map((o) => o.creatorId));
  const searching = s && (s.status === "queued" || s.status === "running");

  return (
    <>
      {searching && <AutoRefresh everyMs={5000} />}
      <h1>{p.title}</h1>
      <p className="sub">
        <Link href="/pitch">← Усі відгуки</Link>
        {fit && <> · <span className={FIT[fit.level].cls}>{FIT[fit.level].label}</span></>}
        {" · "}стан: <b>{PITCH_STATUS[p.status]}</b>
      </p>
      {msg && <div className="flash" role="status">{msg}</div>}
      {!a && p.options && (
        <>
          <AutoRefresh everyMs={10000} />
          <div className="flash">У черзі на розбір: ІІ візьме це замовлення, щойно модель звільниться. Сторінка оновиться сама.</div>
        </>
      )}
      {!a && !p.options && p.issues.length > 0 && <div className="flash risk-high">{p.issues.join("; ")}</div>}

      {a && (
        <section className="card">
          <h2>Про що замовлення</h2>
          <p>{a.summaryUk || "—"}</p>
          <table>
            <tbody>
              <tr><th>Що треба</th><td>{JOB_TYPE[a.jobType]}</td></tr>
              <tr><th>Платформа</th><td>{PLATFORM[a.platform]}</td></tr>
              {a.niche && <tr><th>Ніша</th><td>{a.niche}</td></tr>}
              <tr><th>Бюджет</th><td>{a.budget ? <>${a.budget.amount}{a.budget.kind === "hourly" ? " за годину" : a.budget.kind === "fixed" ? " за все" : ""} <span className="muted">(«{a.budget.quote}»)</span></> : "не вказано"}</td></tr>
              {a.followers && <tr><th>Підписників</th><td>{a.followers.min?.toLocaleString("uk-UA") ?? "…"} – {a.followers.max?.toLocaleString("uk-UA") ?? "…"} <span className="muted">(«{a.followers.quote}»)</span></td></tr>}
              {a.creatorsNeeded && <tr><th>Скільки авторів</th><td>{a.creatorsNeeded.count} <span className="muted">(«{a.creatorsNeeded.quote}»)</span></td></tr>}
            </tbody>
          </table>
          {fit && <ul>{fit.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
          {a.redFlags.length > 0 && (
            <>
              <h3 className="risk-high">Тривожні ознаки</h3>
              <ul>{a.redFlags.map((f) => <li key={f.quote}>{f.text} <span className="muted">(«{f.quote}»)</span></li>)}</ul>
            </>
          )}
          {a.requirements.length > 0 && (
            <>
              <h3>Вимоги замовника</h3>
              <ul>{a.requirements.map((r) => <li key={r.quote}>{r.text} <span className="muted">(«{r.quote}»)</span></li>)}</ul>
            </>
          )}
          {a.dropped > 0 && <p className="muted">Відкинуто тверджень моделі без цитати з тексту: {a.dropped}.</p>}
        </section>
      )}

      <section className="card">
        <h2>Відгук англійською</h2>
        {p.issues.length > 0 && <div className="flash risk-high">Перевірка: {p.issues.join("; ")}. Виправте текст перед відправкою.</div>}
        <form action={saveProposalAction} className="search-form">
          <input type="hidden" name="id" value={p.id} />
          <label className="wide">Текст (можна правити)<textarea name="proposal" rows={14} defaultValue={p.proposal ?? ""} /></label>
          <div className="inline">
            <button>Зберегти правки</button>
            <CopyButton text={p.proposal ?? ""} label="Копіювати відгук" />
          </div>
        </form>
        {p.proposalUk && (
          <details style={{ marginTop: 12 }}>
            <summary>Переклад українською (щоб розуміти, що надсилаєте)</summary>
            <p style={{ whiteSpace: "pre-wrap" }}>{p.proposalUk}</p>
          </details>
        )}
        <p className="muted">
          Надсилаєте ви самі. Перед відправкою відкрийте 2–3 профілі з прикладів і переконайтеся, що вони справді підходять. Email авторів у
          відгук не потрапляють: контакти — після замовлення.
        </p>
        <div className="inline">
          {(["sent", "replied", "won", "lost"] as const).map((st) => (
            <form key={st} action={pitchStatusAction}>
              <input type="hidden" name="id" value={p.id} />
              <input type="hidden" name="status" value={st} />
              <button className="chip" disabled={p.status === st}>{PITCH_STATUS[st]}</button>
            </form>
          ))}
        </div>
        <form action={fromPitchAction} style={{ marginTop: 12 }}>
          <input type="hidden" name="pitchId" value={p.id} />
          <button className="primary">Клієнт відповів → вести замовлення</button>
        </form>
        <p className="muted">Далі ви лише пересилаєте повідомлення клієнта: ІІ збере завдання, спитає, чого бракує, і запустить пошук.</p>
      </section>

      <section className="card">
        <h2>Автори-приклади</h2>
        {!s ? (
          <p className="empty">Пошук прикладів не запускали. Можна створити його вручну в «<Link href="/search">Пошуку креаторів</Link>».</p>
        ) : (
          <>
            <p className="muted">
              Пошук: <Link href={`/search/${s.id}`}>{s.name}</Link> · <span style={{ color: STATUS[s.status].color }}>{STATUS[s.status].label}</span>
              {s.progress && searching ? ` · ${s.progress.stage} ${s.progress.done}/${s.progress.total}` : ""}
              {searching && " · сторінка оновиться сама"}
            </p>
            {options.length === 0 ? (
              <p className="empty">{searching ? "Шукаємо…" : "Відповідних авторів не знайдено. Відкрийте пошук, змініть хештеги й запустіть ще раз."}</p>
            ) : (
              <form action={rewriteAction}>
                <input type="hidden" name="id" value={p.id} />
                <input type="hidden" name="pick" value="1" />
                <table>
                  <thead><tr><th></th><th>Автор</th><th className="num">Підписників</th><th className="num">Залученість</th><th>Чому підходить</th><th className="num">Оцінка</th></tr></thead>
                  <tbody>
                    {options.map((o) => (
                      <tr key={o.creatorId}>
                        <td><input type="checkbox" name="sample" value={o.creatorId} defaultChecked={chosen.has(o.creatorId)} aria-label={`Додати @${o.handle}`} /></td>
                        <td><Link href={`/creators/${o.creatorId}`}>@{o.handle}</Link>{o.lead && <span className="risk-low"> · лід</span>}<div className="muted">{o.platform === "tiktok" ? "TikTok" : "Instagram"}{o.country ? ` · ${o.country}` : ""}</div></td>
                        <td className="num">{o.followersShort ?? "—"}</td>
                        <td className="num">{o.erPct ?? "—"}</td>
                        <td className="muted">{o.why ?? "—"}</td>
                        <td className="num">{o.score}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button className="primary" style={{ marginTop: 12 }}>Додати вибраних у відгук (до {SAMPLE_COUNT})</button>
              </form>
            )}
          </>
        )}
        {p.samples.length > 0 && (
          <>
            <h3>Список для відгуку</h3>
            <pre style={{ whiteSpace: "pre-wrap" }}>{sampleList(p.samples)}</pre>
            <CopyButton text={sampleList(p.samples)} label="Копіювати список" />
          </>
        )}
        <form action={rewriteAction} style={{ marginTop: 12 }}>
          <input type="hidden" name="id" value={p.id} />
          <button className="chip">Переписати відгук без авторів</button>
        </form>
      </section>

      <details className="card">
        <summary>Текст замовлення</summary>
        <p style={{ whiteSpace: "pre-wrap" }}>{p.jobText}</p>
      </details>

      <form action={deletePitchAction}>
        <input type="hidden" name="id" value={p.id} />
        <ConfirmButton question="Видалити цей відгук?">Видалити відгук</ConfirmButton>
      </form>
    </>
  );
}
