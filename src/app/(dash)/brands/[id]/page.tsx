import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { scoutMetrics } from "@/brands";
import { getDb } from "@/db/client";
import { brandScouts, type BrandLead } from "@/db/schema";
import { CopyButton } from "../../creators/print-button";
import { ConfirmButton } from "../../keys/confirm-button";
import { AutoRefresh } from "../../search/auto-refresh";
import { brandVerdictAction, creatorAction, deleteScoutAction, pitchAction, queuePitchesAction, rerunScoutAction } from "../actions";
import { CreatorFields } from "../creator-fields";
import { Numbers } from "../numbers";
import { SCOUT_STATUS, VERDICT } from "../labels";

const n = (v: number | null) => (v == null ? "—" : v.toLocaleString("uk-UA"));
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

function Pitch({ id, l, canWrite, queued }: { id: number; l: BrandLead; canWrite: boolean; queued: boolean }) {
  if (queued) return <span className="muted">у черзі на лист</span>;
  if (l.pitch?.body) {
    return (
      <details>
        <summary>{l.pitch.subject || "лист"}{l.pitch.issues.length > 0 && <span className="risk-high"> · перевірте</span>}</summary>
        {l.pitch.issues.length > 0 && <p className="risk-high">Перевірка: {l.pitch.issues.join("; ")}</p>}
        <pre className="letter">{l.pitch.body}</pre>
        <div className="inline">
          <CopyButton text={`${l.pitch.subject}\n\n${l.pitch.body}`} label="Копіювати" />
          {l.email && <a className="chip" href={`mailto:${l.email}?subject=${encodeURIComponent(l.pitch.subject)}&body=${encodeURIComponent(l.pitch.body)}`}>Відкрити в пошті</a>}
        </div>
        {l.pitch.bodyUk && <p className="muted">Переклад: {l.pitch.bodyUk}</p>}
        {canWrite && <form action={pitchAction}><input type="hidden" name="id" value={id} /><input type="hidden" name="handle" value={l.handle} /><button className="link">Переписати</button></form>}
      </details>
    );
  }
  if (l.pitch?.issues.length) return <span className="risk-high">{l.pitch.issues[0]}</span>;
  return canWrite && l.verdict !== "not_brand"
    ? <form action={pitchAction}><input type="hidden" name="id" value={id} /><input type="hidden" name="handle" value={l.handle} /><button className="link">Написати лист</button></form>
    : <span className="muted">—</span>;
}

export default async function ScoutPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const { msg } = await searchParams;
  const [s] = await getDb().select().from(brandScouts).where(eq(brandScouts.id, id));
  if (!s) notFound();
  const metrics = await scoutMetrics(getDb(), s);
  const st = SCOUT_STATUS[s.status];
  const busy = s.status === "queued" || s.status === "running" || s.pitchQueue.length > 0;
  const shown = s.brands.filter((b) => b.verdict !== "not_brand");
  const hidden = s.brands.filter((b) => b.verdict === "not_brand");
  const st8 = s.stats;
  const canWrite = !!s.creator;
  const queued = new Set(s.pitchQueue);

  const row = (l: BrandLead) => {
    const v = VERDICT[l.verdict];
    return (
      <tr key={l.handle}>
        <td>
          <a href={`https://www.instagram.com/${l.handle}/`} target="_blank" rel="noreferrer">@{l.handle}</a>
          {l.name && <div className="muted">{l.name}</div>}
          {l.category && <div className="muted">{l.category}</div>}
        </td>
        <td>{n(l.followers)}</td>
        <td><Numbers m={metrics.get(l.handle)!} /></td>
        <td>
          {l.email ? <><b>{l.email}</b><div className="muted">{l.emailSource?.startsWith("http") ? "з сайту" : l.emailSource}</div></> : <span className="muted">немає</span>}
          {l.website && <div><a href={l.website} target="_blank" rel="noreferrer">{l.website.replace(/^https?:\/\/(www\.)?/, "").slice(0, 40)}</a></div>}
        </td>
        <td>
          <span className={v.cls}>{v.label}</span>
          <div className="muted">{l.verdictWhy}</div>
          <form action={brandVerdictAction} className="inline">
            <input type="hidden" name="id" value={s.id} /><input type="hidden" name="handle" value={l.handle} />
            {l.verdict !== "brand" && <button className="link" name="verdict" value="brand">це бренд</button>}
            {l.verdict !== "not_brand" && <button className="link" name="verdict" value="not_brand">не бренд</button>}
          </form>
        </td>
        <td><Pitch id={s.id} l={l} canWrite={canWrite} queued={queued.has(l.handle)} /></td>
      </tr>
    );
  };

  return (
    <>
      {busy && <AutoRefresh everyMs={8000} />}
      <h1>Бренди: {s.niche}</h1>
      <p className="sub">
        <Link href="/brands">← Усі пошуки брендів</Link> · <span className={st.cls}>{st.label}</span>
        {s.stage && <> · {s.stage}</>}
        {s.hashtags.length > 0 && <> · {s.hashtags.map((t) => `#${t}`).join(" ")}</>}
      </p>
      {msg && <div className="flash" role="status">{msg}</div>}
      {s.error && <div className="flash risk-high">Помилка: {s.error}</div>}

      {(s.status === "done" || st8.posts != null) && (
        <p className="muted">
          Дописів з хештегів: <b>{st8.posts ?? 0}</b> · авторів перевірено: <b>{st8.creators ?? 0}</b> · рекламних дописів: <b>{st8.adPosts ?? 0}</b> ·
          відмічених акаунтів: <b>{st8.candidates ?? 0}</b> · профілів брендів: <b>{st8.brandProfiles ?? 0}</b> · з email: <b>{st8.withEmail ?? 0}</b> ·
          Apify: <b>${(st8.costUsd ?? 0).toFixed(2)}</b>
        </p>
      )}
      {(st8.notes?.length ?? 0) > 0 && <details><summary className="muted">Примітки збору ({st8.notes!.length})</summary><ul>{st8.notes!.map((x) => <li key={x}>{x}</li>)}</ul></details>}

      {s.status === "done" && (
        <section className="card">
          <h2>Бренди, які вже працюють з авторами ніші ({shown.length})</h2>
          <div className="inline">
            <a className="chip" href={`/brands/${s.id}/export`}>Завантажити CSV для креатора</a>
            {canWrite && (
              <form action={queuePitchesAction}><input type="hidden" name="id" value={s.id} /><button className="primary">Написати листи всім брендам з email</button></form>
            )}
          </div>
          {!canWrite && <p className="muted">Щоб ІІ написав листи від імені креатора, заповніть його дані нижче.</p>}
          {shown.length === 0 ? (
            <p className="empty">Реклами з відмітками брендів не знайдено. Спробуйте інші хештеги (вужчі, ті, де автори показують товари) або більший обсяг.</p>
          ) : (
            <table>
              <thead><tr><th>Бренд</th><th>Підписники</th><th>Співпраця з авторами</th><th>Контакт</th><th>Чи бренд</th><th>Лист</th></tr></thead>
              <tbody>{shown.map(row)}</tbody>
            </table>
          )}
          {hidden.length > 0 && (
            <details>
              <summary className="muted">Відсіяно як «не бренд» ({hidden.length}): автори, фотографи, друзі, закриті профілі</summary>
              <table><tbody>{hidden.map(row)}</tbody></table>
            </details>
          )}
          <p className="muted">
            Цифри — з публічних рекламних дописів у всій вашій базі (кожен пошук авторів поповнює її безкоштовно): скільки різних авторів мали рекламу
            бренду, скільки з них за 90 днів, з кількома працював повторно, розмір цих авторів, вподобання реклами до підписників і опубліковані ставки
            за UGC у цих авторів. Скільки платить сам бренд, з публічних даних не видно.
            Email: з біо Instagram або з головної чи контактної сторінки сайту, домен перевірено на наявність пошти.
          </p>
        </section>
      )}

      <section className="card">
        <h2>Креатор, для якого шукаємо</h2>
        <form action={creatorAction} className="search-form">
          <input type="hidden" name="id" value={s.id} />
          <CreatorFields c={s.creator} />
          <button>Зберегти</button>
        </form>
      </section>

      <section className="card">
        <div className="inline">
          {(s.status === "done" || s.status === "failed") && (
            <form action={rerunScoutAction}><input type="hidden" name="id" value={s.id} /><button>Зібрати знову</button></form>
          )}
          <form action={deleteScoutAction}><input type="hidden" name="id" value={s.id} /><ConfirmButton question="Видалити пошук брендів разом з листами?">Видалити</ConfirmButton></form>
        </div>
      </section>
    </>
  );
}
