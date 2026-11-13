import Link from "next/link";
import { profileUrl } from "@/lib/profile-url";
import { STATUS_LABELS } from "../../creators/labels";
import { startForSearch } from "../../inbox/actions";
import { notFound } from "next/navigation";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { auditView } from "@/audit/vision";
import { getDb } from "@/db/client";
import { clients, creatorContacts, creators, searchCandidates, searches } from "@/db/schema";
import { activityStatus } from "@/enrich/activity";
import { classifyLinks } from "@/enrich/links";
import { calibrate } from "@/search/calibrate";
import { criteriaOf, FORMAT_LABELS, MODE_LABELS, weightsOf } from "@/search/criteria";
import { estimateCostUsd } from "@/search/pipeline";
import { ConfirmButton } from "../../keys/confirm-button";
import { cancelSearch, deleteSearch, rerunSearch, setVerdict, suppress } from "../actions";
import { AutoRefresh } from "../auto-refresh";
import { LANGS, STATUS } from "../labels";

const nf = new Intl.NumberFormat("uk-UA", { notation: "compact", maximumFractionDigits: 1 });
const idx = (n: number | null) => (n == null ? "—" : String(Math.round(n)));
const usd = (n: number | null | undefined) => (n == null ? "—" : `$${n.toFixed(2).replace(".", ",")}`);
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

const VIEWS = {
  qualified: { label: "Підходять", stages: ["qualified"] },
  review: { label: "Перегляньте вручну", stages: ["qualified"] },
  rejected: { label: "Відхилені після профілю", stages: ["rejected"] },
  filtered: { label: "Відсіяні безкоштовно", stages: ["filtered_out", "shortlisted"] },
} as const;
type View = keyof typeof VIEWS;

const ACTIVITY = {
  active: { label: "активний", color: "var(--good)" },
  dormant: { label: "засинає", color: "var(--warning)" },
  ghost: { label: "неактивний", color: "var(--critical)" },
  unknown: { label: "невідомо", color: "var(--ink-3)" },
} as const;
const EMAIL_NOTE: Record<string, string> = { personal: "особиста", business: "власний домен", role: "загальна адреса", unknown: "не перевірено" };
/**
 * Обрізає текст за символами, а не за кодовими одиницями: інакше емодзі розрізається навпіл,
 * браузер замінює половинку на «�», і React бачить розбіжність між сервером і клієнтом.
 */
const clip = (s: string, n: number) => {
  const chars = Array.from(s.replace(/\r\n?/g, "\n"));
  return chars.length > n ? `${chars.slice(0, n).join("")}…` : chars.join("");
};
const RISK: Record<string, string> = { low: "низький", medium: "середній", high: "високий", unknown: "невідомо" };

export default async function SearchDetail({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ view?: string; msg?: string }>;
}) {
  const searchId = Number((await params).id);
  if (!Number.isInteger(searchId)) notFound();
  const db = getDb();
  const [s] = await db.select().from(searches).where(eq(searches.id, searchId));
  if (!s) notFound();
  const { view: viewParam, msg } = await searchParams;
  const [client] = s.clientId ? await db.select({ id: clients.id, name: clients.name }).from(clients).where(eq(clients.id, s.clientId)) : [];
  const view: View = viewParam && viewParam in VIEWS ? (viewParam as View) : "qualified";
  const crit = criteriaOf(s);
  const weights = weightsOf(s);

  const inView = and(eq(searchCandidates.searchId, searchId), inArray(searchCandidates.stage, [...VIEWS[view].stages]),
    view === "review" ? isNotNull(creators.reviewNote) : undefined);
  const [counts, reviewCount, rows] = await Promise.all([
    db.select({ stage: searchCandidates.stage, n: sql<number>`count(*)::int` }).from(searchCandidates)
      .where(eq(searchCandidates.searchId, searchId)).groupBy(searchCandidates.stage),
    db.select({ n: sql<number>`count(*)::int` }).from(searchCandidates).innerJoin(creators, eq(searchCandidates.creatorId, creators.id))
      .where(and(eq(searchCandidates.searchId, searchId), eq(searchCandidates.stage, "qualified"), isNotNull(creators.reviewNote))),
    db.select({ cand: searchCandidates, creator: creators }).from(searchCandidates)
      .innerJoin(creators, eq(searchCandidates.creatorId, creators.id))
      .where(inView)
      .orderBy(desc(searchCandidates.lead), desc(searchCandidates.score), desc(creators.followers))
      .limit(300),
  ]);
  const contacts = rows.length ? await db.select().from(creatorContacts).where(inArray(creatorContacts.creatorId, rows.map((r) => r.creator.id))) : [];
  const labeled = await db.select({ quality: creators.quality, verdict: creators.manualVerdict }).from(creators)
    .where(sql`${creators.manualVerdict} is not null and ${creators.quality} is not null`);
  const cal = calibrate(labeled.map((l) => ({ quality: l.quality!, verdict: l.verdict! })), crit.quality.lead);
  const countOf = (v: View) => v === "review" ? reviewCount[0]?.n ?? 0
    : counts.filter((c) => (VIEWS[v].stages as readonly string[]).includes(c.stage)).reduce((a, c) => a + c.n, 0);
  const active = s.status === "queued" || s.status === "running";
  const pct = s.progress && s.progress.total > 0 ? Math.round((s.progress.done / s.progress.total) * 100) : null;
  const now = new Date();
  const st = s.stats;
  const back = `/search/${s.id}?view=${view}`;
  const src = s.sources ?? {};
  const critLine = [
    s.minFollowers != null || s.maxFollowers != null ? `аудиторія ${s.minFollowers ?? 0}–${s.maxFollowers ?? "∞"} (${MODE_LABELS[crit.followers]})` : null,
    s.countries.length ? `країни ${s.countries.join(", ")} (${MODE_LABELS[crit.country]})` : null,
    s.languages.length ? `мови ${s.languages.join(", ")} (${MODE_LABELS[crit.language]})` : null,
    crit.activity.mode !== "off" ? `допис за ${crit.activity.days} дн. (${MODE_LABELS[crit.activity.mode]})` : null,
    crit.er.mode !== "off" ? `залученість від ${crit.er.minPct}% (${MODE_LABELS[crit.er.mode]})` : null,
    crit.trust.mode !== "off" ? `ризик накрутки не вище «${crit.trust.maxRisk === "low" ? "низький" : "середній"}» (${MODE_LABELS[crit.trust.mode]})` : null,
    crit.ads !== "off" ? `досвід реклами (${MODE_LABELS[crit.ads]})` : null,
    crit.email !== "off" ? `email (${MODE_LABELS[crit.email]})` : null,
    crit.formats.mode !== "off" && crit.formats.list.length ? `формат: ${crit.formats.list.map((f) => FORMAT_LABELS[f]).join(" або ")} (${MODE_LABELS[crit.formats.mode]})` : null,
    `якість від ${crit.quality.min}, лід від ${crit.quality.lead}`,
  ].filter(Boolean);

  return (
    <>
      {active && <AutoRefresh />}
      <p className="muted"><Link href="/search">← Усі пошуки</Link></p>
      <h1>{s.name}</h1>
      <p className="sub">
        {s.platform === "tiktok" ? "TikTok" : "Instagram"} · {s.focus === "affiliate" ? "Афіліати" : "UGC-креатори"} · {[...s.hashtags.map((h) => `#${h}`), ...(src.bioQueries ?? []).map((q) => `«${q}»`),
          ...(src.competitors ?? []).map((c) => `відмітки @${c}`), ...(src.seeds ?? []).map((c) => `схожі на @${c}`), ...(src.places ?? []).map((p) => `місце ${p}`),
          ...(src.webQueries ?? []).map((q) => `веб «${q}»`), ...(src.usernames?.length ? [`список із ${src.usernames.length}`] : [])].join(" · ")}
        {" "}· листи: {LANGS[s.outreachLanguage] ?? s.outreachLanguage} · витрати Apify до {usd(estimateCostUsd(s))}
        {s.targetLeads ? ` · мета: ${s.targetLeads} лідів` : ""}{s.budgetUsd ? ` · бюджет ${usd(s.budgetUsd)}` : ""}
      </p>
      <p className="muted" style={{ marginTop: -12 }}>Критерії: {critLine.join(" · ")}{client ? <> · клієнт: <Link href={`/clients/${client.id}`}>{client.name}</Link></> : null}</p>
      {msg && <div className="flash" role="status">{msg}</div>}

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
                {countOf("qualified") > 0 && <Link href={`/search/${s.id}/report`}><button type="button">Звіт для клієнта</button></Link>}
                {countOf("qualified") > 0 && <a href={`/search/${s.id}/export`}><button type="button">CSV: усі, хто підходить</button></a>}
                {client && (st.leads ?? 0) > 0 && (
                  <form action={startForSearch}><input type="hidden" name="searchId" value={s.id} /><button className="primary">Почати листування з лідами ({st.leads})</button></form>
                )}
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
                <th className="num">Дописів</th><th className="num">Авторів</th><th className="num">Відібрано</th><th className="num">Профілів</th>
                <th className="num">З кешу</th><th className="num">Відомі відмови</th><th className="num">Прочитано моделлю</th><th className="num">З email</th>
                <th className="num">Аудитів</th><th className="num">Роликів</th><th className="num">Коментарів</th><th className="num">Підходять</th>
                <th className="num">Лідів</th><th className="num">Витрачено</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                {[st.posts, st.authors, st.shortlisted, st.profilesFetched, st.profilesReused, st.skippedKnown, st.analyzed, st.withEmail, st.audited,
                  st.deepAudited, st.commentsAnalyzed, st.qualified, st.leads].map((v, i) => <td key={i} className="num">{v ?? "—"}</td>)}
                <td className="num">{usd(st.costUsd)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {st.bySource && Object.keys(st.bySource).length > 0 && (
          <details className="more" style={{ marginTop: 10 }}>
            <summary>Ціна ліда за джерелами</summary>
            <div className="scroll">
              <table style={{ marginTop: 8 }}>
                <thead><tr><th>Джерело</th><th className="num">Авторів</th><th className="num">Підходять</th><th className="num">Лідів</th><th className="num">Витрачено</th><th className="num">За лід</th></tr></thead>
                <tbody>
                  {Object.entries(st.bySource).sort((a, b) => b[1].leads - a[1].leads || b[1].qualified - a[1].qualified).map(([label, x]) => (
                    <tr key={label}>
                      <td>{label}</td><td className="num">{x.authors}</td><td className="num">{x.qualified}</td><td className="num">{x.leads}</td>
                      <td className="num">{usd(x.costUsd)}</td><td className="num">{x.leads ? usd(x.costUsd / x.leads) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
        {(st.notes?.length || st.expandedTags?.length) ? (
          <details className="more" style={{ marginTop: 8 }}>
            <summary>Журнал пошуку</summary>
            <ul className="plain muted">
              {st.expandedTags?.length ? <li>Автопілот додав хештеги: {st.expandedTags.map((t) => `#${t}`).join(" ")}</li> : null}
              {st.notes?.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          </details>
        ) : null}
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
                  <th>Автор</th>
                  <th className="num" title="Зважене середнє індексів">Оцінка</th>
                  <th className="num" title="Ніша й роль">Ніша{weights.fit !== 1 ? ` ×${weights.fit}` : ""}</th>
                  <th className="num" title="Контакт, свіжість, прайс, портфоліо">Готовність</th>
                  <th className="num" title="Якість візуалу">Якість</th>
                  <th className="num" title="Довіра до аудиторії: 100 — ознак накрутки немає">Довіра</th>
                  <th>Активність</th><th>Візуал</th><th>Контакти</th><th>Чому</th><th />
                </tr>
              </thead>
              <tbody>
                {rows.map(({ cand, creator: c }) => {
                  const act = ACTIVITY[activityStatus(c.lastPostAt, now)];
                  const days = c.lastPostAt ? Math.floor((now.getTime() - c.lastPostAt.getTime()) / 86_400_000) : null;
                  const mine = contacts.filter((k) => k.creatorId === c.id && c.emails.includes(k.email));
                  const audit = auditView(c.audit);
                  const hubs = classifyLinks(c.links).hubs;
                  return (
                    <tr key={cand.id}>
                      <td style={{ minWidth: 190 }}>
                        <Link href={`/creators/${c.id}?search=${s.id}`}><b>@{c.username}</b></Link>
                        {" "}<a href={profileUrl(c.platform, c.username)} target="_blank" rel="noreferrer" className="muted" aria-label={`Профіль @${c.username}`}>↗</a>
                        {cand.lead && <div><span className="badge">готовий лід</span></div>}
                        {c.outreachStatus !== "new" && <div><span className="badge">{STATUS_LABELS[c.outreachStatus]}</span></div>}
                        <div className="muted">{[c.displayName, c.followers != null ? `${nf.format(c.followers)} підписників` : null].filter(Boolean).join(" · ")}</div>
                        {(c.country || c.language) && (
                          <div className="muted">{[c.country ? `країна: ${c.country}${(c.countryConfidence ?? 0) < 0.6 ? "?" : ""}` : null, c.language ? `мова: ${c.language}` : null].filter(Boolean).join(" · ")}</div>
                        )}
                        {cand.source && <div className="muted">джерело: {cand.source}</div>}
                        {c.bio && <div className="muted" style={{ maxWidth: 240, overflowWrap: "anywhere" }}>{clip(c.bio, 110)}</div>}
                      </td>
                      <td className="num"><b>{idx(cand.score)}</b></td>
                      <td className="num">{idx(cand.fit)}</td>
                      <td className="num">{idx(cand.readiness)}</td>
                      <td className="num">{idx(cand.quality)}</td>
                      <td className="num">
                        {idx(cand.trust)}
                        {c.trustRisk && c.trustRisk !== "unknown" && <div className={`muted risk-${c.trustRisk}`}>ризик {RISK[c.trustRisk]}</div>}
                      </td>
                      <td>
                        <span className="status"><i style={{ background: act.color }} />{act.label}</span>
                        {days != null && <div className="muted">допис {days === 0 ? "сьогодні" : `${days} дн. тому`}</div>}
                        {c.erLikes != null && <div className="muted">вподобання {(c.erLikes * 100).toFixed(1)}% аудиторії</div>}
                      </td>
                      <td style={{ minWidth: 120 }}>
                        {c.quality != null ? (
                          <>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={`/media/collage/${c.id}`} alt={`Колаж дописів @${c.username}`} width={96} height={96} loading="lazy" className="collage" />
                            {audit?.aesthetic && <div className="muted">{audit.aesthetic}</div>}
                            {audit?.summary && <div className="muted" style={{ maxWidth: 200 }}>{audit.summary}</div>}
                            {c.adQuality != null && <div className="muted">реклама: {Math.round(c.adQuality)}/100</div>}
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
                        {mine.length === 0 && c.links.length === 0 && "—"}
                      </td>
                      <td className="muted" style={{ minWidth: 220, maxWidth: 300 }}>
                        {c.reviewNote && <div style={{ color: "var(--ink)" }}>⚑ {c.reviewNote}</div>}
                        {cand.reasons.join(" · ")}
                      </td>
                      <td>
                        <div className="actions" style={{ marginBottom: 6 }}>
                          {(["yes", "no"] as const).map((v) => (
                            <form action={setVerdict} key={v}>
                              <input type="hidden" name="id" value={c.id} /><input type="hidden" name="back" value={back} /><input type="hidden" name="verdict" value={v} />
                              <button className={c.manualVerdict === v ? "chip on" : "chip"} aria-pressed={c.manualVerdict === v}
                                aria-label={`${v === "yes" ? "Взяв би" : "Не взяв би"} @${c.username}`}>
                                {v === "yes" ? "Взяв би" : "Ні"}
                              </button>
                            </form>
                          ))}
                        </div>
                        <form action={suppress}>
                          <input type="hidden" name="id" value={c.id} /><input type="hidden" name="back" value={back} />
                          <ConfirmButton question={`Видалити всі дані @${c.username} і більше ніколи його не збирати?`} label={`Видалити дані @${c.username} і додати до списку виключень`}>
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
            ? "Позначайте авторів «Взяв би» / «Ні» — за вашими вердиктами система перевірить, чи можна довіряти оцінці якості, і покаже моделі вашу планку."
            : `Розмічено авторів з оцінкою якості: ${cal.labeled}. За порога ${cal.current.threshold} модель згодна з вами у ${cal.current.agree} з ${cal.labeled}.`}
          {cal.labeled > 0 && !cal.best && " Для поради щодо порога потрібно щонайменше 10 вердиктів обох типів."}
          {cal.best && cal.best.threshold !== cal.current.threshold && ` Найкращий збіг дає поріг ${cal.best.threshold}: ${cal.best.agree} з ${cal.labeled}.`}
          {cal.best && cal.best.threshold === cal.current.threshold && " Чинний поріг — найкращий для ваших вердиктів."}
          {" "}<Link href="/quality">Перевірка точності</Link> · <Link href="/help">Що означають оцінки</Link>
        </p>
      </section>
    </>
  );
}
