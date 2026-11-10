import Link from "next/link";
import { desc } from "drizzle-orm";
import { getDb } from "@/db/client";
import { searches } from "@/db/schema";
import { PRICE_PER_RESULT_USD } from "@/search/pipeline";
import { createSearch } from "./actions";
import { AutoRefresh } from "./auto-refresh";
import { LANGS, STATUS } from "./labels";

const df = new Intl.DateTimeFormat("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const { msg } = await searchParams;
  const rows = await getDb().select().from(searches).orderBy(desc(searches.createdAt)).limit(50);
  const active = rows.some((r) => r.status === "queued" || r.status === "running");

  return (
    <>
      {active && <AutoRefresh everyMs={5000} />}
      <h1>Пошук креаторів</h1>
      <p className="sub">Дописи за хештегами → безкоштовний відбір за текстом → профілі лише найкращих → оцінка.</p>
      {msg && <div className="flash" role="status">{msg}</div>}

      <section className="card">
        <h2>Новий пошук</h2>
        <form action={createSearch} className="grid">
          <label>Назва<input name="name" required maxLength={80} placeholder="напр. Косметика, осінь" /></label>
          <label>Хештеги (через кому)<input name="hashtags" required placeholder="ugccreator, skincareugc" /></label>
          <label>Слова ніші (через кому)<input name="keywords" placeholder="skincare, makeup, beauty" /></label>
          <label>Стоп-слова (через кому)<input name="stopWords" placeholder="giveaway, shop" /></label>
          <label>Дописів на хештег<input name="postsPerTag" type="number" min="5" max="200" defaultValue={50} required /></label>
          <label>Профілів щонайбільше<input name="maxProfiles" type="number" min="1" max="300" defaultValue={150} required /></label>
          <label>Підписників від<input name="minFollowers" type="number" min="0" placeholder="1000" /></label>
          <label>Підписників до<input name="maxFollowers" type="number" min="0" placeholder="100000" /></label>
          <label>
            Кого шукаємо
            <select name="focus" defaultValue="ugc">
              <option value="ugc">UGC-креаторів (знімають на замовлення)</option>
              <option value="affiliate">Афіліатів (вітрини, промокоди)</option>
            </select>
          </label>
          <label>Аудит візуалу для найкращих<input name="auditLimit" type="number" min="0" max="150" defaultValue={30} required /></label>
          <label>Країни (коди через кому)<input name="countries" placeholder="US, GB" /></label>
          <label>Мови контенту (коди)<input name="languages" placeholder="en" /></label>
          <label>
            Мова листів
            <select name="outreachLanguage" defaultValue="en">
              {Object.entries(LANGS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <button className="primary">Запустити</button>
        </form>
        <p className="muted" style={{ margin: "12px 0 0" }}>
          Вартість в Apify — приблизно ${PRICE_PER_RESULT_USD} за кожен допис і кожен профіль. Наприклад, 2 хештеги по 50 дописів і 150
          профілів — близько $0,65. Профілі, зібрані за останні 7 днів, повторно не оплачуються. Контакти зі сторінок-візиток
          і перевірка email безкоштовні. Країну й мову визначаємо за непрямими ознаками: автори, у яких їх визначити не вдалося, фільтр проходять; аудит візуалу витрачає ліміт мовної моделі (0 — не робити). Пошук іде у фоні — сторінку можна закрити.
        </p>
      </section>

      <section className="card">
        <h2>Пошуки</h2>
        {rows.length === 0 ? (
          <div className="empty">Пошуків ще не було.</div>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr><th>Назва</th><th>Стан</th><th>Хештеги</th><th className="num">Авторів</th><th className="num">Підходять</th><th className="num">Готових лідів</th><th>Створено</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td><Link href={`/search/${r.id}`}>{r.name}</Link></td>
                    <td>
                      <span className="status"><i style={{ background: STATUS[r.status].color }} />{STATUS[r.status].label}</span>
                      {r.status === "running" && r.progress && <div className="muted">{r.progress.stage}</div>}
                    </td>
                    <td className="muted">{r.hashtags.map((h) => `#${h}`).join(" ")}</td>
                    <td className="num">{r.stats.authors ?? "—"}</td>
                    <td className="num">{r.stats.qualified ?? "—"}</td>
                    <td className="num">{r.stats.leads ?? "—"}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{df.format(r.createdAt)}</td>
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
