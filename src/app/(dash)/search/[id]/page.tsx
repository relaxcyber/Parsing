import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { creatorContacts, creators, searchCandidates, searches } from "@/db/schema";
import { activityStatus } from "@/enrich/activity";
import { classifyLinks } from "@/enrich/links";
import { estimateCostUsd, QUALITY_LEAD } from "@/search/pipeline";
import { ConfirmButton } from "../../keys/confirm-button";
import { calibrate } from "@/search/calibrate";
import { cancelSearch, deleteSearch, rerunSearch, setVerdict, suppress } from "../actions";
import { AutoRefresh } from "../auto-refresh";
import { LANGS, STATUS } from "../labels";

const nf = new Intl.NumberFormat("uk-UA", { notation: "compact", maximumFractionDigits: 1 });
const idx = (n: number | null) => (n == null ? "—" : String(Math.round(n)));
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
  filtered: { label: "Відсіяні за текстом", stages: ["filtered_out", "shortlisted"] },
} as const;
type View = keyof typeof VIEWS;

const ACTIVITY = {
  active: { label: "активний", color: "var(--good)" },
  dormant: { label: "засинає", color: "var(--warning)" },
  ghost: { label: "неактивний", color: "var(--critical)" },
  unknown: { label: "невідомо", color: "var(--ink-3)" },
} as const;
const EMAIL_NOTE: Record<string, string> = {
  personal: "особиста", business: "власний домен", role: "загальна адреса", unknown: "не перевірено",
};
const TIER: Record<string, string> = {
  CINEMA_MIRRORLESS: "камера", FLAGSHIP_SMARTPHONE: "флагманський смартфон", MIDRANGE_SMARTPHONE: "середній смартфон", LOWEND_DEGRADED: "слабка якість",
};

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
      .orderBy(desc(searchCandidates.lead), desc(searchCandidates.score), desc(creators.followers))
      .limit(300),
  ]);
  const contacts = rows.length
    ? await db.select().from(creatorContacts).where(inArray(creatorContacts.creatorId, rows.map((r) => r.creator.id)))
    : [];
  const labeled = await db.select({ quality: creators.quality, verdict: creators.manualVerdict }).from(creators)
    .where(sql`${creators.manualVerdict} is not null and ${creators.quality} is not null`);
  const cal = calibrate(labeled.map((l) => ({ quality: l.quality!, verdict: l.verdict! })), QUALITY_LEAD);
  const countOf = (v: View) => counts.filter((c) => (VIEWS[v].stages as readonly string[]).includes(c.stage)).reduce((a, c) => a + c.n, 0);
  const active = s.status === "queued" || s.status === "running";
  const pct = s.progress && s.progress.total > 0 ? Math.round((s.progress.done / s.progress.total) * 100) : null;
  const now = new Date();
  const st = s.stats;

  return (
    <>
      {active && <AutoRefresh />}
      <p className="muted"><Link href="/search">← Усі пошуки</Link></p>
      <h1>{s.name}</h1>
      <p className="sub">
        {s.focus === "affiliate" ? "Афіліати" : "UGC-креатори"} · {s.hashtags.map((h) => `#${h}`).join(" ")} · по {s.postsPerTag} дописів · до {s.maxProfiles} профілів
        {" "}· листи: {LANGS[s.outreachLanguage] ?? s.outreachLanguage} · оцінка витрат Apify до ${estimateCostUsd(s).toFixed(2).replace(".", ",")}
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
                {countOf("qualified") > 0 && <a href={`/search/${s.id}/export`}><button type="button">CSV: усі, хто підходить</button></a>}
                {(st.withEmail ?? 0) > 0 && <a href={`/search/${s.id}/export?only=email`}><button type="button">CSV для розсилки</button></a>}
                <form action={deleteSearch}>
                  <input type="hidden" name="id" value={s.id} />
                  <ConfirmButton question={`Видалити пошук «${s.name}» разом зі списком кандидатів?`}>Видалити</ConfirmButton>
                </form>
              </>
            )}
          </span>
        </div>
        {s.error && <p className="err" style={{ maxWidth: "none", marginBottom: 0 }} role="alert">{s.error}</p>}
        {st.note && <p className="err" style={{ maxWidth: "none", marginBottom: 0 }}>{st.note}</p>}
        <div className="scroll">
          <table style={{ marginTop: 14 }}>
            <thead>
              <tr>
                <th className="num">Дописів</th><th className="num">Авторів</th><th className="num">Відібрано за текстом</th>
                <th className="num">Профілів зібрано</th><th className="num">З кешу</th><th className="num">Сторінок-візиток</th>
                <th className="num">З email</th><th className="num">Аудитів</th><th className="num">Підходять</th><th className="num">Готових лідів</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                {[st.posts, st.authors, st.shortlisted, st.profilesFetched, st.profilesReused, st.linkPages, st.withEmail, st.audited, st.qualified, st.leads].map((v, i) => (
                  <td key={i} className="num">{v ?? "—"}</td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
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
                  <th>Автор</th><th className="num">Оцінка</th><th className="num">Ніша</th><th className="num">Готовність</th><th className="num">Якість</th>
                  <th>Активність</th><th>Візуал</th><th>Контакти й посилання</th><th>Чому</th><th />
                </tr>
              </thead>
              <tbody>
                {rows.map(({ cand, creator: c }) => {
                  const act = ACTIVITY[activityStatus(c.lastPostAt, now)];
                  const days = c.lastPostAt ? Math.floor((now.getTime() - c.lastPostAt.getTime()) / 86_400_000) : null;
                  const mine = contacts.filter((k) => k.creatorId === c.id && c.emails.includes(k.email));
                  const audit = c.audit as { production_tier?: string; aesthetic?: string; summary?: string } | null;
                  const hubs = classifyLinks(c.links).hubs;
                  return (
                    <tr key={cand.id}>
                      <td style={{ minWidth: 190 }}>
                        <a href={`https://www.instagram.com/${c.username}/`} target="_blank" rel="noreferrer">@{c.username}</a>
                        {cand.lead && <div><span className="badge">готовий лід</span></div>}
                        <div className="muted">{[c.displayName, c.followers != null ? `${nf.format(c.followers)} підписників` : null].filter(Boolean).join(" · ")}</div>
                        {(c.country || c.language) && (
                          <div className="muted">{[c.country ? `країна: ${c.country}${(c.countryConfidence ?? 0) < 0.6 ? "?" : ""}` : null, c.language ? `мова: ${c.language}` : null].filter(Boolean).join(" · ")}</div>
                        )}
                        {c.bio && <div className="muted" style={{ maxWidth: 240, overflowWrap: "anywhere" }}>{c.bio.length > 110 ? `${c.bio.slice(0, 110)}…` : c.bio}</div>}
                      </td>
                      <td className="num"><b>{idx(cand.score)}</b></td>
                      <td className="num">{idx(cand.fit)}</td>
                      <td className="num">{idx(cand.readiness)}</td>
                      <td className="num">{idx(cand.quality)}</td>
                      <td>
                        <span className="status"><i style={{ background: act.color }} />{act.label}</span>
                        {days != null && <div className="muted">допис {days === 0 ? "сьогодні" : `${days} дн. тому`}</div>}
                        {c.erViews != null && <div className="muted">перегляди {Math.round(c.erViews * 100)}% аудиторії</div>}
                      </td>
                      <td style={{ minWidth: 120 }}>
                        {c.quality != null ? (
                          <>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={`/media/collage/${c.id}`} alt={`Колаж дописів @${c.username}`} width={96} height={96} loading="lazy" className="collage" />
                            <div className="muted">{[audit?.aesthetic, audit?.production_tier ? TIER[audit.production_tier] : null].filter(Boolean).join(" · ")}</div>
                            {audit?.summary && <div className="muted" style={{ maxWidth: 200 }}>{audit.summary}</div>}
                          </>
                        ) : "—"}
                      </td>
                      <td style={{ maxWidth: 230, overflowWrap: "anywhere" }}>
                        {mine.map((k) => (
                          <div key={k.email}>
                            <a href={`mailto:${k.email}`}>{k.email}</a>
                            <div className="muted">{EMAIL_NOTE[k.status] ?? k.status} · {k.source === "bio" ? "з біо" : `з ${hostOf(k.sourceUrl)}`}</div>
                          </div>
                        ))}
                        {c.rates.slice(0, 2).map((r) => <div key={r.title} className="muted">прайс: {r.title.slice(0, 60)}</div>)}
                        {c.affiliate.length > 0 && <div className="muted">партнерки: {c.affiliate.join(", ")}</div>}
                        {[...c.portfolio.slice(0, 1), ...hubs.slice(0, 1)].map((l) => <div key={l}><a href={l} target="_blank" rel="noreferrer">{hostOf(l)}</a></div>)}
                        {Object.entries(c.socials).filter(([k]) => k !== "instagram").map(([k, v]) => <div key={k} className="muted">{k}: {v}</div>)}
                        {mine.length === 0 && c.links.length === 0 && "—"}
                      </td>
                      <td className="muted" style={{ minWidth: 200, maxWidth: 280 }}>{cand.reasons.join(" · ")}</td>
                      <td>
                        <div className="actions" style={{ marginBottom: 6 }}>
                          {(["yes", "no"] as const).map((v) => (
                            <form action={setVerdict} key={v}>
                              <input type="hidden" name="id" value={c.id} /><input type="hidden" name="searchId" value={s.id} />
                              <input type="hidden" name="view" value={view} /><input type="hidden" name="verdict" value={v} />
                              <button className={c.manualVerdict === v ? "chip on" : "chip"} aria-pressed={c.manualVerdict === v}
                                aria-label={`${v === "yes" ? "Взяв би" : "Не взяв би"} @${c.username}`}>
                                {v === "yes" ? "Взяв би" : "Ні"}
                              </button>
                            </form>
                          ))}
                        </div>
                        <form action={suppress}>
                          <input type="hidden" name="id" value={c.id} /><input type="hidden" name="searchId" value={s.id} /><input type="hidden" name="view" value={view} />
                          <ConfirmButton
                            question={`Видалити всі дані @${c.username} і більше ніколи його не збирати?`}
                            label={`Видалити дані @${c.username} і додати до списку виключень`}
                          >
                            Виключити
                          </ConfirmButton>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted" style={{ margin: "12px 0 0" }}>
          <b style={{ color: "var(--ink)" }}>Калібрування.</b>{" "}
          {cal.labeled === 0
            ? "Позначайте авторів «Взяв би» / «Ні» — за вашими вердиктами система перевірить, чи можна довіряти оцінці якості."
            : `Розмічено авторів з оцінкою якості: ${cal.labeled}. За порога ${cal.current.threshold} модель згодна з вами у ${cal.current.agree} з ${cal.labeled}.`}
          {cal.labeled > 0 && !cal.best && " Для поради щодо порога потрібно щонайменше 10 вердиктів обох типів."}
          {cal.best && cal.best.threshold !== cal.current.threshold && ` Найкращий збіг дає поріг ${cal.best.threshold}: ${cal.best.agree} з ${cal.labeled}.`}
          {cal.best && cal.best.threshold === cal.current.threshold && " Чинний поріг — найкращий для ваших вердиктів."}
        </p>
        <p className="muted" style={{ margin: "12px 0 0" }}>
          Оцінка — середнє наявних індексів (0–100). «Ніша»: слова ніші в дописах і біо та роль автора. «Готовність»: email 40, допис за тиждень 30
          (за два — 15), прайс 20, портфоліо 10. «Якість»: аудит колажу дописів мовною моделлю. «Готовий лід» — активний автор з особистим email
          і якістю від {QUALITY_LEAD}. Email перевірено на синтаксис і наявність поштового домену, але не пробним листом. «Залученість» нижче 0,3% при аудиторії від 5 тис. позначається
          як можлива накрутка. «Виключити» видаляє дані автора назавжди — використовуйте на запит самого автора.
        </p>
      </section>
    </>
  );
}
