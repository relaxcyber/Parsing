import { desc } from "drizzle-orm";
import { getDb } from "@/db/client";
import { collectRuns, contentItems } from "@/db/schema";
import { scraplingAvailable } from "@/collect/scrapling";
import { runCollect } from "./actions";
import { SubmitButton } from "./submit-button";

const SOURCE: Record<string, string> = { web: "Веб", reddit: "Reddit", instagram: "Instagram", tiktok: "TikTok", x: "X" };
const KIND: Record<string, string> = { post: "допис", comment: "коментар", profile: "профіль", article: "сторінка", video: "відео" };
const VIA: Record<string, string> = { local: "локально", scrapling: "Scrapling", "scrapling-stealth": "Scrapling (браузер)", "reddit-api": "Reddit API", firecrawl: "Firecrawl", apify: "Apify" };

const RUN = {
  running: { label: "Виконується", color: "var(--warning)" },
  done: { label: "Готово", color: "var(--good)" },
  failed: { label: "Помилка", color: "var(--critical)" },
} as const;
const runTarget = (key: string) =>
  key.startsWith("url:") ? key.slice(4)
    : key.startsWith("ig-profile:") ? `Instagram @${key.slice(11)}`
    : key.startsWith("ig-hashtag:") ? `Instagram #${key.split(":")[1]} (${key.split(":")[2]})`
    : key;

const nf = new Intl.NumberFormat("uk-UA", { notation: "compact", maximumFractionDigits: 1 });
const df = new Intl.DateTimeFormat("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
// Ріжемо за символами, а не кодовими одиницями, щоб не розірвати емодзі.
const cut = (s: string | undefined, max: number) => {
  if (!s) return s;
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : s;
};

export default async function CollectPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const { msg } = await searchParams;
  const scrapling = await scraplingAvailable();
  const runs = await getDb().select().from(collectRuns).orderBy(desc(collectRuns.startedAt)).limit(8);
  const rows = await getDb().select().from(contentItems).orderBy(desc(contentItems.fetchedAt), desc(contentItems.id)).limit(50);

  return (
    <>
      <h1>Збір даних</h1>
      <p className="sub">Перевірка збирача: будь-яка сторінка, профіль або хештег Instagram — результат у єдиному форматі.</p>
      {msg && <div className="flash" role="status">{msg}</div>}

      <section className="card">
        <h2>Зібрати</h2>
        <form action={runCollect} className="grid">
          <label>
            Що збираємо
            <select name="mode" defaultValue="url">
              <option value="url">Сторінка за адресою</option>
              <option value="instagram-profile">Профіль Instagram</option>
              <option value="instagram-hashtag">Хештег Instagram</option>
            </select>
          </label>
          <label>Адреса, @профіль або #хештег<input name="value" required placeholder="https://… / @name / #ugccreator" /></label>
          <label>Скільки дописів (для хештега)<input name="limit" type="number" min="1" max="200" defaultValue={20} /></label>
          <label style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <input type="checkbox" name="fresh" /> Зібрати заново (без кешу)
          </label>
          <SubmitButton />
        </form>
        <p className="muted" style={{ margin: "12px 0 0" }}>
          Сторінки спершу завантажуються локально й безкоштовно: прямий запит, потім Scrapling (обхід захисту від ботів).
          Firecrawl витрачає кредит лише коли жоден локальний спосіб не впорався. Instagram іде через Apify і може тривати до кількох хвилин. Повторний запит бере збережене: сторінки й профілі — 24 год, хештеги — 6 год.
          {" "}{scrapling ? "Scrapling встановлено." : "Scrapling не встановлено — захищені сайти одразу підуть у Firecrawl (див. README)."}
        </p>
      </section>

      {runs.length > 0 && (
        <section className="card">
          <h2>Останні запуски</h2>
          <div className="scroll">
            <table>
              <thead><tr><th>Ціль</th><th>Стан</th><th className="num">Елементів</th><th>Початок</th><th>Примітка</th></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td style={{ maxWidth: 380, overflowWrap: "anywhere" }}>{runTarget(r.targetKey)}</td>
                    <td>
                      <span className="status">
                        <i style={{ background: RUN[r.status].color }} />{RUN[r.status].label}
                      </span>
                    </td>
                    <td className="num">{r.status === "done" ? r.itemIds.length : "—"}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{df.format(r.startedAt)}</td>
                    <td className="err">
                      {r.error ?? (r.skipped ? `пропущено: ${r.skipped}` : "")}
                      {r.status === "running" && "Оновіть сторінку, щоб побачити результат"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card">
        <h2>Останні зібрані елементи</h2>
        {rows.length === 0 ? (
          <div className="empty">Ще нічого не зібрано.</div>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr><th>Джерело</th><th>Автор</th><th>Вміст</th><th className="num">Вподобань</th><th className="num">Коментарів</th><th>Медіа</th><th>Спосіб</th><th>Зібрано</th></tr>
              </thead>
              <tbody>
                {rows.map(({ id, data: d, fetchedAt }) => (
                  <tr key={id}>
                    <td>{SOURCE[d.source] ?? d.source}<div className="muted">{KIND[d.kind] ?? d.kind}</div></td>
                    <td>
                      {d.author?.username ? `@${d.author.username}` : (d.author?.displayName ?? "—")}
                      {d.author?.followers != null && <div className="muted">{nf.format(d.author.followers)} підписників</div>}
                    </td>
                    <td style={{ maxWidth: 420, overflowWrap: "anywhere" }}>
                      <a href={d.url} target="_blank" rel="noreferrer">{cut(d.title, 90) ?? cut(d.text, 90) ?? d.url}</a>
                      {d.title && d.text && <div className="muted">{cut(d.text, 140)}</div>}
                      {!!d.author?.links?.length && <div className="muted">Посилань у профілі: {d.author.links.length}</div>}
                    </td>
                    <td className="num">{d.metrics.likes != null ? nf.format(d.metrics.likes) : "—"}</td>
                    <td className="num">{d.metrics.comments != null ? nf.format(d.metrics.comments) : "—"}</td>
                    <td>{d.media.length || "—"}</td>
                    <td>{VIA[d.via] ?? d.via}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{df.format(fetchedAt)}</td>
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
