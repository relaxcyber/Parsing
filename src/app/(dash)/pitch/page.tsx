import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { jobPitches, searches } from "@/db/schema";
import { jobFit, lastProfile } from "@/pitch";
import { STATUS } from "../search/labels";
import { createPitchAction } from "./actions";
import { FIT, PITCH_STATUS } from "./labels";

const df = new Intl.DateTimeFormat("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

const DEFAULT_ABOUT = "I find and vet Instagram and TikTok creators with my own tool: it checks engagement, fake followers and recent activity, and finds a contact for each creator. I review every profile by hand before it goes to the list.";
const DEFAULT_OFFER = "A list of 30 vetted creators for your brand in 48 hours: profile link, followers, engagement and why each one fits. I can also contact them and negotiate for you.";

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");

export default async function PitchPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const { msg } = await searchParams;
  const db = getDb();
  const [rows, profile] = await Promise.all([
    db.select({ p: jobPitches, searchStatus: searches.status }).from(jobPitches).leftJoin(searches, eq(searches.id, jobPitches.searchId))
      .orderBy(desc(jobPitches.id)).limit(200),
    lastProfile(db),
  ]);
  const sent = rows.filter(({ p }) => p.status !== "draft").length;
  const replied = rows.filter(({ p }) => ["replied", "won", "lost"].includes(p.status)).length;
  const won = rows.filter(({ p }) => p.status === "won").length;

  return (
    <>
      <h1>Відгуки на замовлення</h1>
      <p className="sub">
        Вставте текст замовлення з Upwork чи іншої біржі. ІІ перекладе й розбере його, підкаже, чи варто братися, напише короткий відгук
        англійською й запустить невеликий пошук, щоб додати до відгуку 5 реальних авторів під нішу замовника. Надсилаєте ви самі: автоматична
        відправка відгуків на Upwork заборонена.
      </p>
      {msg && <div className="flash" role="status">{msg}</div>}

      <section className="card">
        <h2>Новий відгук</h2>
        <form action={createPitchAction} className="search-form">
          <label className="wide">Текст замовлення (скопіюйте повністю, разом з бюджетом)
            <textarea name="jobText" rows={10} required minLength={80} maxLength={8000} placeholder="We are looking for someone to find 30 UGC creators for our skincare brand…" />
          </label>
          <fieldset>
            <legend>Про вас: модель не додасть досвіду чи цифр, яких тут немає</legend>
            <div className="grid">
              <label>Ваше ім’я (підпис)<input name="name" required maxLength={60} defaultValue={profile?.name ?? ""} placeholder="напр. Yevhen" /></label>
              <label>
                Де шукати приклади
                <select name="platform" defaultValue="auto">
                  <option value="auto">як у замовленні</option>
                  <option value="instagram">Instagram (≈ $1–3 Apify)</option>
                  <option value="tiktok">TikTok (безкоштовно)</option>
                </select>
              </label>
              <label><span><input type="checkbox" name="search" defaultChecked /> Одразу шукати 5 авторів-прикладів</span></label>
            </div>
            <label className="wide">Хто ви й як працюєте (англійською)<textarea name="about" rows={3} maxLength={600} defaultValue={profile?.about ?? DEFAULT_ABOUT} /></label>
            <label className="wide">Що пропонуєте: результат і строк (англійською). Кількість авторів ІІ візьме із замовлення; ціну у відгуку не пише, бо ставку на Upwork вводять окремо<textarea name="offer" rows={3} required maxLength={600} defaultValue={profile?.offer ?? DEFAULT_OFFER} /></label>
          </fieldset>
          <button className="primary">Розібрати й написати відгук</button>
          <p className="muted">Розбір і текст — 10–30 секунд. Пошук прикладів іде у фоні кілька хвилин; потім на сторінці відгуку натисніть «Додати авторів у відгук».</p>
        </form>
      </section>

      <section className="card">
        <h2>Ваші відгуки</h2>
        {rows.length > 0 && (
          <p className="muted">
            Надіслано: <b>{sent}</b> · відповіли: <b>{replied}</b> ({pct(replied, sent)}) · замовлень: <b>{won}</b> ({pct(won, sent)}).
            Орієнтир на перші 30 днів: 100 відгуків і хоча б 3–5 відповідей. Якщо відповідей немає, змінюйте текст і приклади, а не інструмент.
          </p>
        )}
        {rows.length === 0 ? <p className="empty">Ще немає відгуків.</p> : (
          <table>
            <thead><tr><th>Замовлення</th><th>Оцінка</th><th>Бюджет</th><th>Приклади</th><th>Стан</th><th>Коли</th></tr></thead>
            <tbody>
              {rows.map(({ p, searchStatus }) => {
                const fit = p.analysis ? FIT[jobFit(p.analysis).level] : null;
                const b = p.analysis?.budget;
                return (
                  <tr key={p.id}>
                    <td><Link href={`/pitch/${p.id}`}>{p.title}</Link></td>
                    <td>{fit && <span className={fit.cls}>{fit.label}</span>}</td>
                    <td>{b ? `$${b.amount}${b.kind === "hourly" ? "/год" : ""}` : "—"}</td>
                    <td>{p.samples.length ? `${p.samples.length} у відгуку` : searchStatus ? STATUS[searchStatus].label.toLowerCase() : "—"}</td>
                    <td>{PITCH_STATUS[p.status]}</td>
                    <td className="muted">{df.format(p.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
