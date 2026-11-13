import Link from "next/link";
import { desc } from "drizzle-orm";
import { getDb } from "@/db/client";
import { orders } from "@/db/schema";
import { refreshOrder } from "@/orders";
import { lastProfile } from "@/pitch";
import { createOrderAction } from "./actions";
import { ORDER_STATUS } from "./labels";

const df = new Intl.DateTimeFormat("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const { msg } = await searchParams;
  const db = getDb();
  const [raw, profile] = await Promise.all([db.select().from(orders).orderBy(desc(orders.updatedAt)).limit(200), lastProfile(db)]);
  const rows = await Promise.all(raw.map((o) => refreshOrder(db, o)));
  const waiting = rows.filter((o) => o.status === "needs_you" || o.status === "results" || (o.draft && o.status !== "closed")).length;

  return (
    <>
      <h1>Замовлення</h1>
      <p className="sub">
        Ваша частина — знайти клієнта й пересилати сюди його повідомлення. ІІ сам збирає з переписки завдання на пошук, питає клієнта, чого бракує,
        відповідає на його питання з ваших даних, запускає пошук і пише повідомлення з результатом. Те, чого він не знає, — питає вас українською.
      </p>
      {msg && <div className="flash" role="status">{msg}</div>}

      <section className="card">
        <h2>Замовлення{waiting > 0 && <span className="risk-high"> · чекають вас: {waiting}</span>}</h2>
        {rows.length === 0 ? <p className="empty">Ще немає замовлень. Створіть з відгуку («Клієнт відповів») або вставте повідомлення клієнта нижче.</p> : (
          <table>
            <thead><tr><th>Замовлення</th><th>Стан</th><th>Що далі</th><th>Оновлено</th></tr></thead>
            <tbody>
              {rows.map((o) => {
                const st = ORDER_STATUS[o.status];
                return (
                  <tr key={o.id}>
                    <td><Link href={`/orders/${o.id}`}>{o.title}</Link>{o.spec?.count ? <div className="muted">{o.spec.count} авторів · {o.spec.platform ?? "платформа ?"}</div> : null}</td>
                    <td className={st.cls}>{st.label}</td>
                    <td className="muted">{o.draft && o.status !== "needs_you" ? "Відповідь готова — надішліть" : st.next}</td>
                    <td className="muted">{df.format(o.updatedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Нове замовлення</h2>
        <form action={createOrderAction} className="search-form">
          <label className="wide">Повідомлення клієнта або текст замовлення (англійською, як є)
            <textarea name="firstMessage" rows={8} required minLength={30} maxLength={8000} placeholder="Hi! We need 30 TikTok creators for our pet brand in the UK…" />
          </label>
          <div className="grid">
            <label>Ваше ім’я (підпис)<input name="name" maxLength={60} defaultValue={profile?.name ?? ""} required /></label>
          </div>
          <details>
            <summary>Хто ви й що пропонуєте (з останнього відгуку)</summary>
            <label className="wide">Хто ви (англійською)<textarea name="about" rows={3} maxLength={600} defaultValue={profile?.about ?? ""} /></label>
            <label className="wide">Що пропонуєте (англійською)<textarea name="offer" rows={3} maxLength={600} defaultValue={profile?.offer ?? ""} /></label>
          </details>
          <button className="primary">Розібрати</button>
        </form>
      </section>
    </>
  );
}
