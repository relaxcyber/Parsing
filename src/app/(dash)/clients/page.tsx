import Link from "next/link";
import { asc, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { clients, mailboxes, outreachMessages, outreachThreads } from "@/db/schema";
import { ConfirmButton } from "../keys/confirm-button";
import { addMailbox, checkMailbox, createClient, deleteMailbox } from "./actions";

const df = new Intl.DateTimeFormat("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export default async function ClientsPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const { msg } = await searchParams;
  const db = getDb();
  const [rows, boxes, stats, sent] = await Promise.all([
    db.select().from(clients).orderBy(asc(clients.name)),
    db.select().from(mailboxes).orderBy(asc(mailboxes.email)),
    db.select({
      clientId: outreachThreads.clientId,
      total: sql<number>`count(*)::int`,
      human: sql<number>`count(*) filter (where ${outreachThreads.needsHuman} is not null)::int`,
      posted: sql<number>`count(*) filter (where ${outreachThreads.status} = 'posted')::int`,
    }).from(outreachThreads).groupBy(outreachThreads.clientId),
    db.select({ mailboxId: outreachMessages.mailboxId, n: sql<number>`count(*)::int` }).from(outreachMessages)
      .where(sql`${outreachMessages.status} = 'sent' and ${outreachMessages.sentAt} > now() - interval '1 day'`).groupBy(outreachMessages.mailboxId),
  ]);

  return (
    <>
      <h1>Клієнти</h1>
      <p className="sub">
        Для кожного бренду — правила переговорів: що пропонуємо, скільки можемо платити, строки й права. ІІ листується з авторами в цих межах,
        а питання поза правилами передає вам у «<Link href="/inbox">Листування</Link>». Ваша відповідь стає новим правилом.
      </p>
      {msg && <div className="flash" role="status">{msg}</div>}

      <section className="card">
        <h2>Бренди</h2>
        {rows.length === 0 ? <p className="empty">Ще немає клієнтів.</p> : (
          <table>
            <thead><tr><th>Клієнт</th><th>Режим</th><th className="num">Листувань</th><th className="num">Потрібна людина</th><th className="num">Дописів</th></tr></thead>
            <tbody>
              {rows.map((c) => {
                const s = stats.find((x) => x.clientId === c.id);
                return (
                  <tr key={c.id}>
                    <td><Link href={`/clients/${c.id}`}>{c.name}</Link>{!c.mailboxId && <div className="muted">⚠ не вибрано скриньку</div>}</td>
                    <td>{c.policy.mode === "auto" ? "ІІ надсилає сам" : "листи чекають вашого «Надіслати»"}</td>
                    <td className="num">{s?.total ?? 0}</td>
                    <td className="num">{s?.human ? <Link href="/inbox?tab=human"><b>{s.human}</b></Link> : 0}</td>
                    <td className="num">{s?.posted ?? 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <form action={createClient} className="inline" style={{ marginTop: 12, maxWidth: 480 }}>
          <input name="name" placeholder="Назва бренду" aria-label="Назва бренду" required minLength={2} maxLength={80} />
          <button className="primary">Додати клієнта</button>
        </form>
      </section>

      <section className="card" id="mailboxes">
        <h2>Поштові скриньки</h2>
        <p className="muted">
          З цих скриньок ідуть листи авторам і з них читаються відповіді. Для Gmail увімкніть двоетапну перевірку й створіть
          «Пароль застосунку» (Google-акаунт → Безпека → Паролі застосунків) — звичайний пароль не підійде. Краще окрема скринька
          на окремому домені: нова скринька, що надсилає багато листів, швидко потрапляє в спам — починайте з 20–30 на добу.
        </p>
        {boxes.length > 0 && (
          <table>
            <thead><tr><th>Скринька</th><th>Сервери</th><th className="num">Надіслано за добу</th><th>Перевірено</th><th></th></tr></thead>
            <tbody>
              {boxes.map((b) => (
                <tr key={b.id}>
                  <td>{b.email}{b.fromName ? <div className="muted">{b.fromName}</div> : null}</td>
                  <td className="mono">{b.smtpHost}:{b.smtpPort}<br />{b.imapHost}:{b.imapPort}</td>
                  <td className="num">{sent.find((x) => x.mailboxId === b.id)?.n ?? 0} з {b.dailyLimit}</td>
                  <td>{b.lastError ? <span className="err">⚠ {b.lastError}</span> : b.lastPolledAt ? `✓ ${df.format(b.lastPolledAt)}` : "ще ні"}</td>
                  <td className="actions">
                    <form action={checkMailbox}><input type="hidden" name="id" value={b.id} /><button className="link">Перевірити</button></form>
                    <form action={deleteMailbox}><input type="hidden" name="id" value={b.id} /><ConfirmButton question={`Видалити скриньку ${b.email}?`}>Видалити</ConfirmButton></form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <details className="more" open={boxes.length === 0} style={{ marginTop: 12 }}>
          <summary>Підключити скриньку</summary>
          <form action={addMailbox} className="grid" style={{ marginTop: 10 }}>
            <label>Адреса<input name="email" type="email" required placeholder="team@yourbrand.com" /></label>
            <label>Пароль застосунку<input name="password" type="password" required autoComplete="new-password" /></label>
            <label>Ім’я відправника<input name="fromName" placeholder="напр. Anna from Glow Lab" /></label>
            <label>
              Поштовий сервіс
              <select name="preset" defaultValue="gmail">
                <option value="gmail">Gmail / Google Workspace</option>
                <option value="outlook">Outlook / Microsoft 365</option>
                <option value="zoho">Zoho Mail (EU)</option>
                <option value="ukrnet">ukr.net</option>
                <option value="">інший — вкажу сервери</option>
              </select>
            </label>
            <label>Листів на добу<input name="dailyLimit" type="number" min={1} max={500} defaultValue={30} /></label>
            <label>SMTP-сервер (для «іншого»)<input name="smtpHost" placeholder="smtp.example.com" /></label>
            <label>SMTP-порт<input name="smtpPort" type="number" placeholder="465" /></label>
            <label>IMAP-сервер<input name="imapHost" placeholder="imap.example.com" /></label>
            <label>IMAP-порт<input name="imapPort" type="number" placeholder="993" /></label>
            <label>Логін, якщо не адреса<input name="username" /></label>
            <button className="primary">Підключити й перевірити</button>
          </form>
        </details>
      </section>
    </>
  );
}
