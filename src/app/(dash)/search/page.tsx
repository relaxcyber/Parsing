import Link from "next/link";
import { desc } from "drizzle-orm";
import { getDb } from "@/db/client";
import { searches, searchTemplates } from "@/db/schema";
import { BUILTIN_TEMPLATES } from "@/search/templates";
import { ConfirmButton } from "../keys/confirm-button";
import { deleteTemplate } from "./actions";
import { AutoRefresh } from "./auto-refresh";
import { STATUS } from "./labels";
import { SearchForm } from "./search-form";

const df = new Intl.DateTimeFormat("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const usd = (n: number | undefined) => (n == null ? "—" : `$${n.toFixed(2).replace(".", ",")}`);

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const { msg } = await searchParams;
  const db = getDb();
  const [rows, saved] = await Promise.all([
    db.select().from(searches).orderBy(desc(searches.createdAt)).limit(50),
    db.select().from(searchTemplates).orderBy(searchTemplates.name),
  ]);
  const active = rows.some((r) => r.status === "queued" || r.status === "running");
  const templates = [...BUILTIN_TEMPLATES, ...saved.map((t) => ({ name: t.name, data: t.data }))];

  return (
    <>
      {active && <AutoRefresh everyMs={5000} />}
      <h1>Пошук креаторів</h1>
      <p className="sub">
        Джерела → безкоштовний відбір за текстом → профілі лише найкращих → довіра до аудиторії, реклама, аналіз тексту →
        контакти → оцінка візуалу й роликів → коментарі. <Link href="/help">Як читати оцінки</Link>
      </p>
      {msg && <div className="flash" role="status">{msg}</div>}

      <section className="card">
        <h2>Новий пошук</h2>
        <SearchForm templates={templates} />
        {saved.length > 0 && (
          <div className="muted" style={{ marginTop: 12 }}>
            Ваші шаблони:{" "}
            {saved.map((t) => (
              <form action={deleteTemplate} key={t.id} style={{ display: "inline" }}>
                <input type="hidden" name="id" value={t.id} />
                {t.name} <ConfirmButton question={`Видалити шаблон «${t.name}»?`} label={`Видалити шаблон ${t.name}`}>×</ConfirmButton>{" "}
              </form>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <h2>Пошуки</h2>
        {rows.length === 0 ? (
          <div className="empty">Пошуків ще не було.</div>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Назва</th><th>Стан</th><th>Джерела</th><th className="num">Авторів</th><th className="num">Підходять</th>
                  <th className="num">Готових лідів</th><th className="num">Витрачено</th><th className="num">За лід</th><th>Створено</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const src = r.sources ?? {};
                  const sources = [
                    ...r.hashtags.map((h) => `#${h}`),
                    ...(src.bioQueries ?? []).map((q) => `«${q}»`),
                    ...(src.competitors ?? []).map((c) => `відмітки @${c}`),
                    ...(src.seeds?.length ? [`схожі на ${src.seeds.length}`] : []),
                    ...(src.places ?? []).map((p) => `місце: ${p}`),
                    ...(src.webQueries?.length ? [`веб: ${src.webQueries.length}`] : []),
                    ...(src.usernames?.length ? [`список: ${src.usernames.length}`] : []),
                  ];
                  const perLead = r.stats.leads && r.stats.costUsd != null ? r.stats.costUsd / r.stats.leads : undefined;
                  return (
                    <tr key={r.id}>
                      <td>
                        <Link href={`/search/${r.id}`}>{r.name}</Link>
                        {r.repeatDays && <div className="muted">повтор кожні {r.repeatDays} дн.</div>}
                      </td>
                      <td>
                        <span className="status"><i style={{ background: STATUS[r.status].color }} />{STATUS[r.status].label}</span>
                        {r.status === "running" && r.progress && <div className="muted">{r.progress.stage}</div>}
                      </td>
                      <td className="muted" style={{ maxWidth: 260 }}>{sources.slice(0, 6).join(" ")}{sources.length > 6 ? " …" : ""}</td>
                      <td className="num">{r.stats.authors ?? "—"}</td>
                      <td className="num">{r.stats.qualified ?? "—"}</td>
                      <td className="num">{r.stats.leads ?? "—"}{r.targetLeads ? <span className="muted"> / {r.targetLeads}</span> : null}</td>
                      <td className="num">{usd(r.stats.costUsd)}</td>
                      <td className="num">{usd(perLead)}</td>
                      <td style={{ whiteSpace: "nowrap" }}>{df.format(r.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
