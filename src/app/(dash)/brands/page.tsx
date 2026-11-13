import Link from "next/link";
import { desc } from "drizzle-orm";
import { estimateScoutUsd, MAX_TAGS } from "@/brands";
import { getDb } from "@/db/client";
import { brandScouts } from "@/db/schema";
import { createScoutAction } from "./actions";
import { CreatorFields } from "./creator-fields";
import { SCOUT_STATUS } from "./labels";

const df = new Intl.DateTimeFormat("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const usd = (v: number) => `≈ $${v.toFixed(2)}`;

export default async function BrandsPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const { msg } = await searchParams;
  const db = getDb();
  const rows = await db.select().from(brandScouts).orderBy(desc(brandScouts.id)).limit(200);
  const last = rows.find((r) => r.creator)?.creator ?? null;

  return (
    <>
      <h1>Бренди для креаторів</h1>
      <p className="sub">
        Зворотний бік пошуку авторів: для креатора знаходимо бренди, які <b>вже платять</b> авторам у його ніші. Інструмент збирає дописи з
        хештегів ніші, знаходить серед них рекламу (позначка «Платне партнерство», #ad, промокоди, спільні дописи) і бренди, відмічені в
        ній. Потім перевіряє профілі брендів, шукає email у біо й на сайті та пише від імені креатора короткий лист кожному. Результат: файл,
        який можна продати креатору або віддати як бонус.
      </p>
      {msg && <div className="flash" role="status">{msg}</div>}
      <p>
        <Link href="/brands/base"><b>База брендів →</b></Link>{" "}
        <span className="muted">усі бренди з реклами авторів з цифрами співпраці; кожен пошук креаторів поповнює її безкоштовно</span>
      </p>

      <section className="card">
        <h2>Новий пошук брендів</h2>
        <form action={createScoutAction} className="search-form">
          <div className="grid">
            <label>Ніша (англійською)<input name="niche" required minLength={3} maxLength={200} placeholder="dog care" /></label>
            <label>Хештеги (необов’язково, до {MAX_TAGS}; порожньо — підбере ІІ)<input name="hashtags" maxLength={400} placeholder="dogsofinstagram, dogmom, puppylove" /></label>
            <label>
              Обсяг
              <select name="size" defaultValue="normal">
                <option value="small">Малий: 40 авторів, 30 брендів ({usd(estimateScoutUsd({ tags: 4, postsPerTag: 30, maxCreators: 40, maxBrands: 30 }))})</option>
                <option value="normal">Звичайний: 60 авторів, 40 брендів ({usd(estimateScoutUsd({ tags: 4, postsPerTag: 40, maxCreators: 60, maxBrands: 40 }))})</option>
                <option value="big">Великий: 100 авторів, 60 брендів ({usd(estimateScoutUsd({ tags: 4, postsPerTag: 60, maxCreators: 100, maxBrands: 60 }))})</option>
              </select>
            </label>
          </div>
          <details>
            <summary>Креатор, для якого шукаємо (можна заповнити пізніше, потрібно лише для листів)</summary>
            <CreatorFields c={last} />
          </details>
          <button className="primary">Шукати бренди</button>
          <p className="muted">
            Витрати лише Apify (Instagram), оцінка вказана у виборі обсягу. Сайти брендів відкриваються звичайними запитами, безкоштовно.
            Займає 3–10 хвилин; дописи, зібрані за останні 6 годин, вдруге не оплачуються.
          </p>
        </form>
      </section>

      <section className="card">
        <h2>Ваші пошуки брендів</h2>
        {rows.length === 0 ? <p className="empty">Ще немає.</p> : (
          <table>
            <thead><tr><th>Ніша</th><th>Стан</th><th>Брендів</th><th>З email</th><th>Листів</th><th>Витрачено</th><th>Коли</th></tr></thead>
            <tbody>
              {rows.map((s) => {
                const st = SCOUT_STATUS[s.status];
                return (
                  <tr key={s.id}>
                    <td><Link href={`/brands/${s.id}`}>{s.niche}</Link>{s.creator?.name && <span className="muted"> · для {s.creator.name}</span>}</td>
                    <td><span className={st.cls}>{st.label}</span></td>
                    <td>{s.status === "done" ? s.brands.filter((b) => b.verdict !== "not_brand").length : "…"}</td>
                    <td>{s.status === "done" ? s.brands.filter((b) => b.verdict !== "not_brand" && b.email).length : "…"}</td>
                    <td>{s.brands.filter((b) => b.pitch?.body).length}</td>
                    <td>{s.stats.costUsd != null ? `$${s.stats.costUsd.toFixed(2)}` : "—"}</td>
                    <td className="muted">{df.format(s.createdAt)}</td>
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
