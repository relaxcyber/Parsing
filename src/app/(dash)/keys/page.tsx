import { asc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { apiKeys, providers, usageEvents, type ApiKey, type Provider } from "@/db/schema";
import { SECRET_HINTS } from "@/keys/presets";
import { canSync } from "@/keys/quota-sync";
import { availableAt, effectiveUsed, keyState, nextPeriodStart, type KeyState } from "@/keys/router";
import { addKey, addProvider, deleteKey, deleteProvider, setProviderModel, syncKey, toggleKey } from "./actions";
import { ConfirmButton } from "./confirm-button";

const UNIT: Record<string, string> = { requests: "запитів", credits: "кредитів", tokens: "токенів", usd: "$" };
const PERIOD: Record<string, string> = { minute: "за хвилину", day: "за добу", month: "за місяць", none: "без скидання" };
const STATE: Record<KeyState, { label: string; color: string }> = {
  active: { label: "Активний", color: "var(--good)" },
  cooldown: { label: "Пауза", color: "var(--warning)" },
  exhausted: { label: "Вичерпано", color: "var(--serious)" },
  invalid: { label: "Недійсний", color: "var(--critical)" },
  disabled: { label: "Вимкнено", color: "var(--ink-3)" },
};

const nf = new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 2 });
const df = new Intl.DateTimeFormat("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const when = (d: Date | null) => (d ? df.format(d) : "—");
const amount = (v: number, unit: string) => (unit === "usd" ? `$${nf.format(v)}` : nf.format(v));

function QuotaMeter({ k, now }: { k: ApiKey; now: Date }) {
  const used = effectiveUsed(k, now);
  const reset = nextPeriodStart(k.quotaPeriod, now);
  if (k.quotaLimit == null) {
    return (
      <div className="muted">
        Використано {amount(used, k.quotaUnit)} {k.quotaUnit !== "usd" && UNIT[k.quotaUnit]} · ліміт не задано
      </div>
    );
  }
  const share = Math.min(1, used / k.quotaLimit);
  const tone = share >= 0.9 ? "critical" : share >= 0.7 ? "warning" : "accent";
  const left = Math.max(0, k.quotaLimit - used);
  return (
    <div className="meter">
      <div
        className="track"
        style={{ background: `var(--${tone}-track)` }}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={k.quotaLimit}
        aria-valuenow={used}
        aria-label={`Використано ${amount(used, k.quotaUnit)} з ${amount(k.quotaLimit, k.quotaUnit)}`}
        title={`Використано ${amount(used, k.quotaUnit)} з ${amount(k.quotaLimit, k.quotaUnit)} (${Math.round(share * 100)}%)`}
      >
        {used > 0 && <div className="fill" style={{ width: `${share * 100}%`, background: `var(--${tone})` }} />}
      </div>
      <div className="nums">
        <span>
          <b>{amount(left, k.quotaUnit)}</b> з {amount(k.quotaLimit, k.quotaUnit)} {k.quotaUnit !== "usd" && UNIT[k.quotaUnit]}
        </span>
        <span>{Math.round(share * 100)}%</span>
      </div>
      <div className="muted">{reset ? `${PERIOD[k.quotaPeriod]} · скидання ${when(reset)}` : PERIOD.none}</div>
    </div>
  );
}

function KeyTable({ rows, now }: { rows: { key: ApiKey; provider: Provider }[]; now: Date }) {
  if (rows.length === 0) return <div className="empty">Ключів ще немає — додайте перший у формі нижче.</div>;
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th>Провайдер</th><th>Ключ</th><th>Стан</th><th>Залишок квоти</th><th>Останній виклик</th><th>Дії</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ key: k, provider: p }) => {
            const state = keyState(k, now);
            const back = availableAt(k, now);
            return (
              <tr key={k.id}>
                <td>{p.name}</td>
                <td>
                  {k.label}
                  <div className="mono">{k.secretTail ? `••••${k.secretTail}` : "••••"}</div>
                </td>
                <td>
                  <span className="status"><i style={{ background: STATE[state].color }} />{STATE[state].label}</span>
                  {back && <div className="muted">до {when(back)}</div>}
                </td>
                <td><QuotaMeter k={k} now={now} /></td>
                <td>
                  {when(k.lastUsedAt)}
                  {k.lastError && <div className="err">{k.lastError}</div>}
                  {k.lastSyncedAt && <div className="muted">звірено {when(k.lastSyncedAt)}</div>}
                </td>
                <td>
                  <div className="actions">
                    {canSync(p.slug) && (
                      <form action={syncKey}><input type="hidden" name="id" value={k.id} /><button className="link">Звірити</button></form>
                    )}
                    <form action={toggleKey}>
                      <input type="hidden" name="id" value={k.id} />
                      <button className="link">{k.status === "active" ? "Вимкнути" : "Увімкнути"}</button>
                    </form>
                    <form action={deleteKey}>
                      <input type="hidden" name="id" value={k.id} />
                      <ConfirmButton question={`Видалити ключ «${k.label}»?`}>Видалити</ConfirmButton>
                    </form>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default async function KeysPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const { msg } = await searchParams;
  const db = getDb();
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86400_000);

  const [allProviders, keyRows, usage] = await Promise.all([
    db.select().from(providers).orderBy(asc(providers.kind), asc(providers.name)),
    db.select({ key: apiKeys, provider: providers }).from(apiKeys)
      .innerJoin(providers, eq(apiKeys.providerId, providers.id))
      .orderBy(asc(providers.name), asc(apiKeys.label)),
    db.select({
        name: providers.name,
        calls: sql<number>`count(*)::int`,
        errors: sql<number>`count(*) filter (where not ${usageEvents.ok})::int`,
        limited: sql<number>`count(*) filter (where ${usageEvents.httpStatus} = 429)::int`,
      })
      .from(usageEvents)
      .innerJoin(apiKeys, eq(usageEvents.keyId, apiKeys.id))
      .innerJoin(providers, eq(apiKeys.providerId, providers.id))
      .where(gte(usageEvents.at, weekAgo))
      .groupBy(providers.name)
      .orderBy(asc(providers.name)),
  ]);

  const scrapers = keyRows.filter((r) => r.provider.kind === "scraper");
  const llms = keyRows.filter((r) => r.provider.kind === "llm");
  const llmProviders = allProviders.filter((p) => p.kind === "llm");
  const hints = allProviders.filter((p) => SECRET_HINTS[p.slug]);

  return (
    <>
      <h1>Ключі та ліміти</h1>
      <p className="sub">Система сама обирає ключ із найбільшим залишком і перемикається, коли провайдер відмовляє.</p>
      {msg && <div className="flash" role="status">{msg}</div>}

      <section className="card">
        <h2>Збір даних</h2>
        <KeyTable rows={scrapers} now={now} />
      </section>

      <section className="card">
        <h2>Мовні моделі</h2>
        <KeyTable rows={llms} now={now} />
      </section>

      <section className="card">
        <h2>Додати ключ</h2>
        <form action={addKey} className="grid">
          <label>
            Провайдер
            <select name="providerId" required>
              {allProviders.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label>Назва<input name="label" required maxLength={80} placeholder="напр. основний" /></label>
          <label>Ключ<input name="secret" type="password" required autoComplete="off" /></label>
          <label>Ліміт (необов’язково)<input name="quotaLimit" type="number" min="0" step="any" /></label>
          <label>
            Одиниця
            <select name="quotaUnit" defaultValue="requests">
              <option value="requests">запити</option><option value="credits">кредити</option>
              <option value="tokens">токени</option><option value="usd">долари</option>
            </select>
          </label>
          <label>
            Скидання ліміту
            <select name="quotaPeriod" defaultValue="month">
              <option value="minute">щохвилини</option><option value="day">щодоби</option>
              <option value="month">щомісяця</option><option value="none">не скидається</option>
            </select>
          </label>
          <button className="primary">Додати</button>
        </form>
        <p className="muted" style={{ margin: "12px 0 0" }}>
          Ключ шифрується перед записом у базу. Для Apify, Firecrawl і OpenRouter ліміт підтягується від провайдера автоматично.
          {hints.map((p) => ` ${p.name}: ключ у форматі ${SECRET_HINTS[p.slug]}.`)}
        </p>
      </section>

      <section className="card">
        <h2>Провайдери мовних моделей</h2>
        <div className="scroll">
          <table>
            <thead><tr><th>Назва</th><th>Адреса API</th><th>Модель</th><th /></tr></thead>
            <tbody>
              {llmProviders.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td className="mono">{p.baseUrl}</td>
                  <td>
                    <form action={setProviderModel} className="inline">
                      <input type="hidden" name="id" value={p.id} />
                      <input name="model" defaultValue={p.model ?? ""} placeholder="не задано" aria-label={`Модель для ${p.name}`} />
                      <button>Зберегти</button>
                    </form>
                  </td>
                  <td>
                    {!p.builtin && (
                      <form action={deleteProvider}>
                        <input type="hidden" name="id" value={p.id} />
                        <ConfirmButton question={`Видалити «${p.name}» разом з усіма його ключами?`}>Видалити</ConfirmButton>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h2 style={{ marginTop: 20 }}>Новий агрегатор</h2>
        <form action={addProvider} className="grid">
          <label>Назва<input name="name" required maxLength={60} /></label>
          <label>Адреса API (сумісна з OpenAI)<input name="baseUrl" type="url" required placeholder="https://…/v1" /></label>
          <label>Модель (необов’язково)<input name="model" maxLength={120} /></label>
          <button>Додати провайдера</button>
        </form>
      </section>

      <section className="card">
        <h2>Виклики за 7 днів</h2>
        {usage.length === 0 ? (
          <div className="empty">Викликів ще не було.</div>
        ) : (
          <div className="scroll"><table>
            <thead><tr><th>Провайдер</th><th className="num">Викликів</th><th className="num">Помилок</th><th className="num">Відмов через ліміт</th></tr></thead>
            <tbody>
              {usage.map((u) => (
                <tr key={u.name}><td>{u.name}</td><td className="num">{nf.format(u.calls)}</td><td className="num">{nf.format(u.errors)}</td><td className="num">{nf.format(u.limited)}</td></tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>
    </>
  );
}
