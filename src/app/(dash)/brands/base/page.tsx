import Link from "next/link";
import { brandBase, ITEM_USD, VERIFY_BATCH } from "@/brands";
import { getDb } from "@/db/client";
import { accountVerdictAction, requestVerifyAction } from "../actions";
import { VERDICT } from "../labels";
import { Numbers } from "../numbers";
import { filterOf, queryOf, type BaseParams } from "./filter";

const costText = (usd: number) => (usd < 0.01 ? "менше $0.01" : `≈ $${usd.toFixed(2)}`);
const n = (v: number | null) => (v == null ? "—" : v.toLocaleString("uk-UA"));

export default async function BrandBasePage({ searchParams }: { searchParams: Promise<BaseParams> }) {
  const p = await searchParams;
  const f = filterOf(p);
  const rows = await brandBase(getDb(), f);
  const query = queryOf(p);
  // Платну перевірку пропонуємо лише для тих, у кого є вагомі докази: кілька авторів або позначка «Платне партнерство».
  const toVerify = rows.filter(({ a, m }) => !a.checkedAt && !a.verifyRequestedAt && (m.creators >= 2 || m.paidPosts > 0)).map(({ a }) => a.id);
  const queued = rows.filter(({ a }) => a.verifyRequestedAt && !a.checkedAt).length;
  const active = rows.filter(({ m }) => m.active90 > 0).length;
  const withEmail = rows.filter(({ a }) => a.email).length;

  return (
    <>
      <h1>База брендів</h1>
      <p className="sub">
        <Link href="/brands">← Пошуки брендів</Link> · Бренди з реклами авторів: кожен пошук креаторів поповнює базу безкоштовно (дописи вже зібрані),
        пошуки брендів додають ще. Усі цифри пораховано кодом з публічних дописів.
      </p>
      {p.msg && <div className="flash" role="status">{p.msg}</div>}

      <section className="card">
        <form className="search-form" method="get">
          <div className="grid">
            <label>Пошук (ім’я, біо, категорія)<input name="q" defaultValue={p.q ?? ""} placeholder="dog, skincare, coffee" /></label>
            <label>Розмір креатора (підписники)<input name="size" defaultValue={p.size ?? ""} placeholder="8k" /></label>
            <label>
              Мінімум авторів
              <select name="min" defaultValue={p.min ?? "1"}>
                <option value="1">1+</option><option value="2">2+</option><option value="3">3+</option><option value="5">5+</option>
              </select>
            </label>
            <label>
              Профіль
              <select name="show" defaultValue={p.show ?? "all"}>
                <option value="all">усі, крім «не бренд»</option><option value="checked">перевірені</option><option value="unchecked">неперевірені</option>
              </select>
            </label>
          </div>
          <label><span><input type="checkbox" name="email" defaultChecked={p.email === "on"} /> лише з email</span></label>
          <div className="inline">
            <button className="primary">Показати</button>
            <a className="chip" href={`/brands/base/export${query ? `?${query}` : ""}`}>CSV з цими фільтрами</a>
          </div>
          <p className="muted">«Розмір креатора»: лише бренди, які вже працювали з авторами схожого розміру (від половини найменшого до подвоєного найбільшого).</p>
        </form>
      </section>

      <section className="card">
        <h2>{rows.length} брендів · активні за 90 днів: {active} · з email: {withEmail}</h2>
        {toVerify.length > 0 && (
          <form action={requestVerifyAction} className="inline">
            <input type="hidden" name="query" value={query} />
            {toVerify.slice(0, 200).map((id) => <input key={id} type="hidden" name="ids" value={id} />)}
            <button>Перевірити профілі {Math.min(toVerify.length, 200)} брендів з кількома авторами ({costText(Math.min(toVerify.length, 200) * ITEM_USD)})</button>
          </form>
        )}
        {queued > 0 && <p className="muted">У черзі на перевірку: {queued} (по {VERIFY_BATCH} за раз у фоні).</p>}
        <p className="muted">
          Неперевірений бренд — лише відмітка в рекламі: це може бути друг чи фотограф. Перевірка відкриває профіль (категорія, сайт), шукає email у біо й на сайті.
        </p>
        {rows.length === 0 ? (
          <p className="empty">Поки порожньо. База наповнюється з пошуків креаторів в Instagram і з пошуків брендів.</p>
        ) : (
          <table>
            <thead><tr><th>Бренд</th><th>Підписники</th><th>Співпраця з авторами</th><th>Контакт</th><th>Чи бренд</th></tr></thead>
            <tbody>
              {rows.map(({ a, m }) => {
                const v = a.verdict ? VERDICT[a.verdict] : null;
                return (
                  <tr key={a.id}>
                    <td>
                      <a href={`https://www.instagram.com/${a.handle}/`} target="_blank" rel="noreferrer">@{a.handle}</a>
                      {a.name && <div className="muted">{a.name}</div>}
                      {a.category && <div className="muted">{a.category}</div>}
                    </td>
                    <td>{n(a.followers)}</td>
                    <td><Numbers m={m} /></td>
                    <td>
                      {a.email ? <b>{a.email}</b> : <span className="muted">{a.checkedAt ? "немає" : "—"}</span>}
                      {a.website && <div><a href={a.website} target="_blank" rel="noreferrer">{a.website.replace(/^https?:\/\/(www\.)?/, "").slice(0, 40)}</a></div>}
                    </td>
                    <td>
                      {v ? <span className={v.cls}>{v.label}</span> : <span className="muted">{a.verifyRequestedAt ? "перевіряється" : "не перевірено"}</span>}
                      {a.verdictWhy && <div className="muted">{a.verdictWhy}</div>}
                      <form action={accountVerdictAction} className="inline">
                        <input type="hidden" name="handle" value={a.handle} /><input type="hidden" name="query" value={query} />
                        {a.verdict !== "brand" && <button className="link" name="verdict" value="brand">це бренд</button>}
                        <button className="link" name="verdict" value="not_brand">не бренд</button>
                      </form>
                    </td>
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
