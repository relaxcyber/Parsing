import Link from "next/link";
import { desc } from "drizzle-orm";
import { getDb } from "@/db/client";
import { scrapeJobs } from "@/db/schema";
import { MAX_URLS } from "@/scrape/jobs";
import { AutoRefresh } from "../search/auto-refresh";
import { STATUS } from "../search/labels";
import { createJob } from "./actions";

const df = new Intl.DateTimeFormat("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const MODE = { auto: "автоматично", selectors: "за селекторами", ai: "мовною моделлю" } as const;

export default async function ScrapePage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const { msg } = await searchParams;
  const rows = await getDb().select().from(scrapeJobs).orderBy(desc(scrapeJobs.createdAt)).limit(50);
  const active = rows.some((r) => r.status === "queued" || r.status === "running");
  return (
    <>
      {active && <AutoRefresh everyMs={5000} />}
      <h1>Парсинг сайтів</h1>
      <p className="sub">Список адрес → потрібні поля з кожної сторінки → таблиця та експорт. Працює у фоні.</p>
      {msg && <div className="flash" role="status">{msg}</div>}

      <section className="card">
        <h2>Нове завдання</h2>
        <form action={createJob} className="stack">
          <label>Назва<input name="name" required maxLength={80} placeholder="напр. Ціни конкурентів" /></label>
          <label>
            Адреси — по одній на рядок, до {MAX_URLS}. Можна вказати карту сайту (…/sitemap.xml) — вона розгорнеться у список сторінок
            <textarea name="urls" rows={6} required placeholder={"https://shop.example/product/1\nhttps://shop.example/product/2"} />
          </label>
          <label>
            Як витягати поля
            <select name="mode" defaultValue="auto">
              <option value="auto">Автоматично — назва, ціна, валюта, наявність, опис, зображення (за розміткою сторінки)</option>
              <option value="selectors">За CSS-селекторами — точно й безкоштовно, потрібно знати розмітку</option>
              <option value="ai">Мовною моделлю — достатньо назвати поля словами (витрачає ліміт моделі)</option>
            </select>
          </label>
          <label>
            Поля. Для селекторів — «назва = селектор», атрибут через @: <span className="mono">price = .product-price</span>,{" "}
            <span className="mono">photo = img.main @src</span>. Для моделі — назви через кому: <span className="mono">ціна, назва, наявність</span>
            <textarea name="fields" rows={3} placeholder={"price = .price\ntitle = h1"} />
          </label>
          <label style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <input type="checkbox" name="allowPaid" /> Використовувати Firecrawl (платні кредити), якщо сторінка не віддалася безкоштовно
          </label>
          <div><button className="primary">Запустити</button></div>
        </form>
      </section>

      <section className="card">
        <h2>Завдання</h2>
        {rows.length === 0 ? (
          <div className="empty">Завдань ще не було.</div>
        ) : (
          <div className="scroll">
            <table>
              <thead><tr><th>Назва</th><th>Стан</th><th>Режим</th><th className="num">Готово</th><th className="num">Помилок</th><th>Створено</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td><Link href={`/scrape/${r.id}`}>{r.name}</Link></td>
                    <td><span className="status"><i style={{ background: STATUS[r.status].color }} />{STATUS[r.status].label}</span></td>
                    <td>{MODE[r.mode]}</td>
                    <td className="num">{r.done} з {r.total}</td>
                    <td className="num">{r.failed}</td>
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
