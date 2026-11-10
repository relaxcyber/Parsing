import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { creators, searchCandidates, searches } from "@/db/schema";
import { estimateCostUsd } from "@/search/pipeline";
import { ConfirmButton } from "../../keys/confirm-button";
import { cancelSearch, deleteSearch, rerunSearch } from "../actions";
import { AutoRefresh } from "../auto-refresh";
import { LANGS, STATUS } from "../labels";

const nf = new Intl.NumberFormat("uk-UA", { notation: "compact", maximumFractionDigits: 1 });
const one = (n: number | null) => (n == null ? "—" : n.toFixed(1).replace(".", ","));
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

const VIEWS = {
  qualified: { label: "Підходять", stages: ["qualified"] },
  rejected: { label: "Відхилені після профілю", stages: ["rejected"] },
  filtered: { label: "Відсіяні за текстом", stages: ["filtered_out"] },
} as const;
type View = keyof typeof VIEWS;

export default async function SearchDetail({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ view?: string }>;
}) {
  const searchId = Number((await params).id);
  if (!Number.isInteger(searchId)) notFound();
  const db = getDb();
  const [s] = await db.select().from(searches).where(eq(searches.id, searchId));
  if (!s) notFound();
  const viewParam = (await searchParams).view;
  const view: View = viewParam && viewParam in VIEWS ? (viewParam as View) : "qualified";

  const [counts, rows] = await Promise.all([
    db.select({ stage: searchCandidates.stage, n: sql<number>`count(*)::int` }).from(searchCandidates)
      .where(eq(searchCandidates.searchId, searchId)).groupBy(searchCandidates.stage),
    db.select({ cand: searchCandidates, creator: creators }).from(searchCandidates)
      .innerJoin(creators, eq(searchCandidates.creatorId, creators.id))
      .where(and(eq(searchCandidates.searchId, searchId), inArray(searchCandidates.stage, [...VIEWS[view].stages])))
      .orderBy(desc(searchCandidates.score), desc(creators.followers))
      .limit(300),
  ]);
  const countOf = (v: View) => counts.filter((c) => (VIEWS[v].stages as readonly string[]).includes(c.stage)).reduce((a, c) => a + c.n, 0);
  const active = s.status === "queued" || s.status === "running";
  const pct = s.progress && s.progress.total > 0 ? Math.round((s.progress.done / s.progress.total) * 100) : null;

  return (
    <>
      {active && <AutoRefresh />}
      <p className="muted"><Link href="/search">← Усі пошуки</Link></p>
      <h1>{s.name}</h1>
      <p className="sub">
        {s.hashtags.map((h) => `#${h}`).join(" ")} · по {s.postsPerTag} дописів · до {s.maxProfiles} профілів · листи: {LANGS[s.outreachLanguage] ?? s.outreachLanguage}
        {" "}· оцінка витрат до ${estimateCostUsd(s).toFixed(2).replace(".", ",")}
      </p>

      <section className="card">
        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <span className="status"><i style={{ background: STATUS[s.status].color }} /><b>{STATUS[s.status].label}</b></span>
          {s.status === "running" && s.progress && (
            <span role="status">{s.progress.stage}{pct != null && s.progress.total > 1 ? ` — ${s.progress.done} з ${s.progress.total} (${pct}%)` : "…"}</span>
          )}
          {s.status === "queued" && <span className="muted">Почнеться за кілька секунд</span>}
          <span style={{ marginLeft: "auto" }} className="actions">
            {active ? (
              <form action={cancelSearch}><input type="hidden" name="id" value={s.id} /><button>Скасувати</button></form>
            ) : (
              <>
                <form action={rerunSearch}><input type="hidden" name="id" value={s.id} /><button>Запустити знову</button></form>
                {countOf("qualified") > 0 && <a href={`/search/${s.id}/export`}><button type="button">Завантажити CSV</button></a>}
                <form action={deleteSearch}>
                  <input type="hidden" name="id" value={s.id} />
                  <ConfirmButton question={`Видалити пошук «${s.name}» разом зі списком кандидатів?`}>Видалити</ConfirmButton>
                </form>
              </>
            )}
          </span>
        </div>
        {s.error && <p className="err" style={{ maxWidth: "none", marginBottom: 0 }} role="alert">{s.error}</p>}
        <table style={{ marginTop: 14 }}>
          <thead>
            <tr>
              <th className="num">Дописів</th><th className="num">Авторів</th><th className="num">Відібрано за текстом</th>
              <th className="num">Профілів зібрано</th><th className="num">Профілів з кешу</th><th className="num">Підходять</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              {[s.stats.posts, s.stats.authors, s.stats.shortlisted, s.stats.profilesFetched, s.stats.profilesReused, s.stats.qualified].map((v, i) => (
                <td key={i} className="num">{v ?? "—"}</td>
              ))}
            </tr>
          </tbody>
        </table>
      </section>

      <section className="card">
        <div className="tabs">
          {(Object.keys(VIEWS) as View[]).map((v) => (
            <Link key={v} href={`/search/${s.id}?view=${v}`} className={v === view ? "on" : undefined} aria-current={v === view ? "page" : undefined}>
              {VIEWS[v].label} · {countOf(v)}
            </Link>
          ))}
        </div>
        {rows.length === 0 ? (
          <div className="empty">{active ? "Список з’явиться, щойно завершиться відбір." : "У цій групі нікого немає."}</div>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Автор</th><th className="num">Підписників</th><th className="num">Оцінка</th><th className="num">Ніша</th>
                  <th className="num">Готовність</th><th>Чому</th><th>Контакти й посилання</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ cand, creator: c }) => (
                  <tr key={cand.id}>
                    <td>
                      <a href={`https://www.instagram.com/${c.username}/`} target="_blank" rel="noreferrer">@{c.username}</a>
                      {c.displayName && <div className="muted">{c.displayName}</div>}
                      {c.bio && <div className="muted" style={{ maxWidth: 260, overflowWrap: "anywhere" }}>{c.bio.length > 120 ? `${c.bio.slice(0, 120)}…` : c.bio}</div>}
                    </td>
                    <td className="num">{c.followers != null ? nf.format(c.followers) : "—"}</td>
                    <td className="num"><b>{one(cand.score)}</b></td>
                    <td className="num">{one(cand.fit)}</td>
                    <td className="num">{one(cand.readiness)}</td>
                    <td className="muted" style={{ maxWidth: 280 }}>{cand.reasons.join(" · ")}</td>
                    <td style={{ maxWidth: 240, overflowWrap: "anywhere" }}>
                      {c.emails.map((e) => <div key={e}><a href={`mailto:${e}`}>{e}</a></div>)}
                      {c.links.slice(0, 3).map((l) => <div key={l}><a href={l} target="_blank" rel="noreferrer">{hostOf(l)}</a></div>)}
                      {c.emails.length === 0 && c.links.length === 0 && "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted" style={{ margin: "12px 0 0" }}>
          Оцінка — середнє «Ніші» та «Готовності» (0–10) за текстом дописів і біо. Якість візуалу додасть наступний крок — аудит зображень.
        </p>
      </section>
    </>
  );
}
