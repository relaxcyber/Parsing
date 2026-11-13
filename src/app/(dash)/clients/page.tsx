import Link from "next/link";
import { asc, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { clients, mailboxes, outreachThreads } from "@/db/schema";
import { ConfirmButton } from "../keys/confirm-button";
import { mailboxHealth } from "@/outreach/deliver";
import { addMailbox, checkMailbox, createClient, deleteMailbox, resumeMailbox, setWarmup } from "./actions";

const df = new Intl.DateTimeFormat("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export default async function ClientsPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const { msg } = await searchParams;
  const db = getDb();
  const [rows, boxes, stats] = await Promise.all([
    db.select().from(clients).orderBy(asc(clients.name)),
    db.select().from(mailboxes).orderBy(asc(mailboxes.email)),
    db.select({
      clientId: outreachThreads.clientId,
      total: sql<number>`count(*)::int`,
      human: sql<number>`count(*) filter (where ${outreachThreads.needsHuman} is not null)::int`,
      posted: sql<number>`count(*) filter (where ${outreachThreads.status} = 'posted')::int`,
    }).from(outreachThreads).groupBy(outreachThreads.clientId),
  ]);
  const health = await Promise.all(boxes.map((b) => mailboxHealth(db, b)));

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
          на окремому домені: нова скринька, що надсилає багато листів, швидко потрапляє в спам. Тому нова скринька розганяється
          (5 листів на добу, +2 щодня до вашого ліміту), адреси перевіряються перед першим листом (якщо на сторінці «Ключі» додано
          MillionVerifier, ZeroBounce чи Hunter), а коли повернень за тиждень понад 5% — скринька зупиняється сама.
        </p>
        {boxes.length > 0 && (
          <table>
            <thead><tr><th>Скринька</th><th>Домен</th><th className="num">Надіслано за добу</th><th className="num">Повернень за тиждень</th><th>Стан</th><th></th></tr></thead>
            <tbody>
              {boxes.map((b, i) => {
                const h = health[i];
                return (
                  <tr key={b.id}>
                    <td>{b.email}{b.fromName ? <div className="muted">{b.fromName}</div> : null}<div className="mono">{b.smtpHost}:{b.smtpPort} · {b.imapHost}:{b.imapPort}</div></td>
                    <td style={{ maxWidth: 280 }}>
                      {!b.dns ? <span className="muted">не перевірено</span> : b.dns.freemail ? <span className="muted">безкоштовна пошта</span> : (
                        <span>SPF {b.dns.spf ? "✓" : "✗"} · DKIM {b.dns.dkimSelector ? "✓" : "?"} · DMARC {b.dns.dmarc ? "✓" : "✗"}</span>
                      )}
                      {b.dns?.warnings.map((w) => <div key={w} className="muted">⚠ {w}</div>)}
                    </td>
                    <td className="num">
                      {h.sent24h} з {h.limit}
                      {b.warmup && h.limit < b.dailyLimit && <div className="muted">розгін до {b.dailyLimit}</div>}
                      <form action={setWarmup} className="muted"><input type="hidden" name="id" value={b.id} />
                        <label className="check" style={{ justifyContent: "flex-end" }}><input type="checkbox" name="warmup" defaultChecked={b.warmup} />розгін</label>
                        <button className="link">зберегти</button>
                      </form>
                    </td>
                    <td className="num">{h.sent7d ? `${h.bounced7d} з ${h.sent7d} (${Math.round((h.bounceRate ?? 0) * 100)}%)` : "—"}</td>
                    <td>
                      {b.pausedAt ? <span className="risk-high">⏸ зупинено: {b.pausedReason}</span>
                        : b.lastError ? <span className="err">⚠ {b.lastError}</span>
                        : b.lastPolledAt ? `✓ ${df.format(b.lastPolledAt)}` : "ще ні"}
                    </td>
                    <td className="actions">
                      {b.pausedAt && <form action={resumeMailbox}><input type="hidden" name="id" value={b.id} /><button>Відновити</button></form>}
                      <form action={checkMailbox}><input type="hidden" name="id" value={b.id} /><button className="link">Перевірити</button></form>
                      <form action={deleteMailbox}><input type="hidden" name="id" value={b.id} /><ConfirmButton question={`Видалити скриньку ${b.email}?`}>Видалити</ConfirmButton></form>
                    </td>
                  </tr>
                );
              })}
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
            <label className="check"><input type="checkbox" name="warmup" defaultChecked />Розгін: 5 на добу, +2 щодня</label>
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
