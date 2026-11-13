import Link from "next/link";
import { profileLabel, profileUrl } from "@/lib/profile-url";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import type { AdsReport } from "@/analysis/ads";
import type { CommentMetrics, CommentsAnalysis } from "@/analysis/comments";
import type { PostMetrics } from "@/analysis/posts";
import type { ProfileAnalysis } from "@/analysis/profile";
import type { TrustReport } from "@/analysis/trust";
import type { DeepAudit } from "@/audit/deep";
import { auditView } from "@/audit/vision";
import { getDb } from "@/db/client";
import { clients, creatorContacts, creators, outreachDrafts, outreachThreads, searchCandidates, searches } from "@/db/schema";
import { activityStatus } from "@/enrich/activity";
import { FORMAT_LABELS } from "@/search/criteria";
import { createDraft, setOutreachStatus, setVerdict, suppress } from "../../search/actions";
import { ConfirmButton } from "../../keys/confirm-button";
import { startThreadAction } from "../../inbox/actions";
import { STATUS_LABELS, THREAD_LABELS } from "../labels";
import { CopyButton, PrintButton } from "../print-button";

const nf = new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 1 });
const df = new Intl.DateTimeFormat("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric" });
const pct = (x: number | null | undefined, d = 1) => (x == null ? "—" : `${(x * 100).toFixed(d)}%`);
const num = (x: number | null | undefined) => (x == null ? "—" : nf.format(x));

const RISK = { low: "низький", medium: "середній", high: "високий", unknown: "не оцінено" } as const;
const ACCOUNT = {
  individual_creator: "окремий автор", business_or_brand: "бізнес чи бренд", agency_or_platform: "агенція чи платформа",
  fan_or_meme_page: "сторінка репостів", unknown: "не визначено",
} as const;
const TRI = { yes: "так", no: "ні", unknown: "невідомо" } as const;
const SCORE_LABELS = { sharpness: "Різкість", lighting: "Світло", framing: "Кадр", background: "Фон" } as const;

function Quotes({ items }: { items?: string[] }) {
  if (!items?.length) return null;
  return <>{items.map((q) => <blockquote key={q}>«{q}»</blockquote>)}</>;
}

export default async function CreatorCard({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; search?: string }>;
}) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const { msg, search } = await searchParams;
  const db = getDb();
  const [c] = await db.select().from(creators).where(eq(creators.id, id));
  if (!c) notFound();
  const [contacts, drafts, appearances, threads, clientRows] = await Promise.all([
    db.select().from(creatorContacts).where(eq(creatorContacts.creatorId, id)),
    db.select().from(outreachDrafts).where(eq(outreachDrafts.creatorId, id)).orderBy(desc(outreachDrafts.createdAt)).limit(5),
    db.select({ cand: searchCandidates, name: searches.name }).from(searchCandidates).innerJoin(searches, eq(searchCandidates.searchId, searches.id))
      .where(eq(searchCandidates.creatorId, id)).orderBy(desc(searchCandidates.createdAt)).limit(20),
    db.select({ t: outreachThreads, client: clients.name }).from(outreachThreads).innerJoin(clients, eq(clients.id, outreachThreads.clientId))
      .where(eq(outreachThreads.creatorId, id)).orderBy(desc(outreachThreads.updatedAt)),
    db.select({ id: clients.id, name: clients.name, mailboxId: clients.mailboxId }).from(clients).orderBy(clients.name),
  ]);
  const searchId = Number(search) || appearances[0]?.cand.searchId || null;
  const m = c.metrics as PostMetrics | null;
  const trust = c.trust as TrustReport | null;
  const ads = c.ads as AdsReport | null;
  const analysis = c.analysis as ProfileAnalysis | null;
  const audit = auditView(c.audit);
  const deep = c.deepAudit as DeepAudit | null;
  const comments = c.commentsReport as { metrics?: CommentMetrics; analysis?: CommentsAnalysis | null; free?: boolean } | null;
  const back = `/creators/${id}${searchId ? `?search=${searchId}` : ""}`;
  const now = new Date();
  const days = c.lastPostAt ? Math.floor((now.getTime() - c.lastPostAt.getTime()) / 86_400_000) : null;

  return (
    <>
      <p className="muted no-print">
        {searchId ? <Link href={`/search/${searchId}`}>← До пошуку</Link> : <Link href="/creators">← Усі креатори</Link>}
      </p>
      <h1>@{c.username} {c.displayName ? <span className="muted" style={{ fontSize: 16, fontWeight: 400 }}>{c.displayName}</span> : null}</h1>
      <p className="sub">
        <a href={profileUrl(c.platform, c.username)} target="_blank" rel="noreferrer">{profileLabel(c.platform, c.username)}</a>
        {c.businessCategory ? ` · ${c.businessCategory}` : ""}{c.country ? ` · країна ${c.country}` : ""}{c.language ? ` · мова ${c.language}` : ""}
        {c.profileFetchedAt ? ` · дані на ${df.format(c.profileFetchedAt)}` : ""}
      </p>
      {msg && <div className="flash" role="status">{msg}</div>}
      {c.reviewNote && <div className="flash">⚑ {c.reviewNote}</div>}

      <section className="card no-print">
        <div className="actions" style={{ alignItems: "center" }}>
          <form action={setOutreachStatus} className="actions" style={{ alignItems: "center" }}>
            <input type="hidden" name="id" value={c.id} /><input type="hidden" name="back" value={back} />
            <label style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              Статус
              <select name="status" defaultValue={c.outreachStatus}>
                {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <input name="note" defaultValue={c.outreachNote ?? ""} placeholder="нотатка: ставка, домовленості" style={{ minWidth: 240 }} />
            <button>Зберегти</button>
          </form>
          {(["yes", "no"] as const).map((v) => (
            <form action={setVerdict} key={v}>
              <input type="hidden" name="id" value={c.id} /><input type="hidden" name="back" value={back} /><input type="hidden" name="verdict" value={v} />
              <button className={c.manualVerdict === v ? "chip on" : "chip"} aria-pressed={c.manualVerdict === v}>{v === "yes" ? "Взяв би" : "Ні"}</button>
            </form>
          ))}
          <PrintButton />
          <form action={suppress} style={{ marginLeft: "auto" }}>
            <input type="hidden" name="id" value={c.id} /><input type="hidden" name="back" value={searchId ? `/search/${searchId}` : "/creators"} />
            <ConfirmButton question={`Видалити всі дані @${c.username} і більше ніколи його не збирати?`}>Виключити</ConfirmButton>
          </form>
        </div>
        {c.outreachAt && <p className="muted" style={{ margin: "8px 0 0" }}>Статус змінено {df.format(c.outreachAt)}</p>}
      </section>

      <section className="card">
        <h2>Цифри</h2>
        <div className="kv">
          <div><b>{num(c.followers)}</b><span>підписників</span></div>
          <div><b>{num(c.follows)}</b><span>підписок</span></div>
          <div><b>{pct(c.erLikes, 2)}</b><span>вподобання / аудиторія{trust?.norm ? ` (норма ${pct(trust.norm.erLikes)}${trust.norm.source === "default" ? ", орієнтовно" : ""})` : ""}</span></div>
          <div><b>{num(m?.medianLikes)}</b><span>медіана вподобань</span></div>
          <div><b>{num(m?.medianComments)}</b><span>медіана коментарів</span></div>
          <div><b>{m?.commentsPerLike != null ? `1 : ${Math.round(1 / Math.max(m.commentsPerLike, 0.0001))}` : "—"}</b><span>коментарів до вподобань</span></div>
          <div><b>{num(c.medianViews)}</b><span>медіана переглядів</span></div>
          <div><b>{m?.postsPerWeek ?? "—"}</b><span>дописів на тиждень</span></div>
          <div><b>{days == null ? "—" : days === 0 ? "сьогодні" : `${days} дн.`}</b><span>від останнього допису ({activityStatus(c.lastPostAt, now) === "active" ? "активний" : "неактивний"})</span></div>
          <div><b>{c.quality != null ? Math.round(c.quality) : "—"}</b><span>якість візуалу</span></div>
          <div><b>{c.adQuality != null ? Math.round(c.adQuality) : "—"}</b><span>рекламна подача</span></div>
        </div>
      </section>

      <div className="two">
        <section className="card">
          <h2>Довіра до аудиторії: <span className={`risk-${trust?.risk ?? "unknown"}`}>ризик {RISK[trust?.risk ?? "unknown"]}</span></h2>
          {trust ? (
            <ul className="plain">{trust.signals.map((s, i) => <li key={i} className={s.level === "info" ? "muted" : undefined}>{s.level === "high" ? "‼ " : s.level === "medium" ? "! " : ""}{s.text}</li>)}</ul>
          ) : <p className="muted">Ще не оцінено.</p>}
          <p className="muted">Публічні дані не дають точного «відсотка ботів»: це перелік ознак, які варто перевірити. Країну й вік аудиторії просіть в автора скриншотом статистики.</p>
        </section>

        <section className="card">
          <h2>Реклама</h2>
          {ads ? (
            <>
              <p>Рекламних дописів: <b>{ads.adPosts}</b> з {ads.posts}
                {ads.adLikesRatio != null && <> · реклама збирає <b>{Math.round(ads.adLikesRatio * 100)}%</b> вподобань звичайного допису</>}</p>
              {ads.brands.length > 0 && <p>Бренди: {ads.brands.map((b) => `@${b.name}${b.count > 1 ? ` ×${b.count}` : ""}`).join(", ")}</p>}
              {ads.repeatBrands.length > 0 && <p>Повторні замовлення: {ads.repeatBrands.map((b) => `@${b}`).join(", ")}</p>}
              {ads.competitors.length > 0 && <p>Працював з конкурентами: {ads.competitors.map((b) => `@${b}`).join(", ")}</p>}
              <ul className="plain">{ads.examples.map((e) => <li key={e.url}><a href={e.url} target="_blank" rel="noreferrer">допис</a> — {e.reason}</li>)}</ul>
            </>
          ) : <p className="muted">Ще не оцінено.</p>}
        </section>
      </div>

      <section className="card">
        <h2>Хто це (аналіз тексту профілю)</h2>
        {analysis ? (
          <>
            <p>Тип акаунта: <b>{ACCOUNT[analysis.accountType.value]}</b></p><Quotes items={analysis.accountType.evidence} />
            <p>UGC-креатор: <b>{TRI[analysis.ugcCreator.value]}</b> · афіліат: <b>{TRI[analysis.affiliate.value]}</b> · відкритий до співпраці: <b>{TRI[analysis.openToCollabs.value]}</b></p>
            <Quotes items={[...analysis.ugcCreator.evidence, ...analysis.affiliate.evidence, ...analysis.openToCollabs.evidence].slice(0, 4)} />
            {analysis.niches.length > 0 && <p>Ніші: {analysis.niches.map((n) => n.name).join(", ")}</p>}
            {analysis.briefFit && <p>Відповідність брифу: <b>{analysis.briefFit.score}/5</b> — {analysis.briefFit.reason}</p>}
            {analysis.summary && <p className="muted">{analysis.summary}</p>}
            <p className="muted">Кожен висновок має дослівну цитату з біо чи підписів; твердження без цитати відкинуто ({analysis.dropped}). Модель: {analysis.model}.</p>
          </>
        ) : <p className="muted">Ще не аналізувався.</p>}
      </section>

      <div className="two">
        <section className="card">
          <h2>Візуал</h2>
          {c.quality != null ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/media/collage/${c.id}`} alt={`Колаж дописів @${c.username}`} width={320} height={320} className="collage" />
              {audit?.aesthetic && <p><b>{audit.aesthetic}</b></p>}
              {audit?.summary && <p>{audit.summary}</p>}
              {audit?.scores && (
                <table>
                  <tbody>
                    {(Object.keys(SCORE_LABELS) as (keyof typeof SCORE_LABELS)[]).map((k) => (
                      <tr key={k}>
                        <td>{SCORE_LABELS[k]}</td>
                        <td className="num">{audit.scores![k]?.score ?? "—"}/5</td>
                        <td className="muted">{audit.scores![k]?.frames?.length ? `кадри ${audit.scores![k].frames.join(", ")}` : "без кадрів — не враховано"}{audit.scores![k]?.note ? ` · ${audit.scores![k].note}` : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {c.auditVersion && <p className="muted">Версія оцінки: {c.auditVersion}{c.auditedAt ? `, ${df.format(c.auditedAt)}` : ""}</p>}
            </>
          ) : <p className="muted">Аудиту ще не було.</p>}
        </section>

        <section className="card">
          <h2>Ролики й мовлення</h2>
          {deep ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/media/collage/${c.id}?deep=1`} alt={`Кадри з роликів @${c.username}`} width={360} className="collage" />
              <ul className="plain">
                <li>Зачіпка в першу секунду: <b>{deep.hook.score ?? "—"}/5</b>{deep.hook.note ? ` — ${deep.hook.note}` : ""}{deep.hook.quote ? <blockquote>«{deep.hook.quote}»</blockquote> : null}</li>
                <li>Говорить у камеру: <b>{TRI[deep.speaksToCamera.value]}</b></li>
                <li>Товар у дії: <b>{TRI[deep.productInUse.value]}</b></li>
                <li>Називає користь: <b>{TRI[deep.benefitStated.value]}</b>{deep.benefitStated.quote ? <blockquote>«{deep.benefitStated.quote}»</blockquote> : null}</li>
                <li>Заклик до дії: <b>{TRI[deep.callToAction.value]}</b>{deep.callToAction.quote ? <blockquote>«{deep.callToAction.quote}»</blockquote> : null}</li>
                <li>Субтитри: <b>{TRI[deep.subtitles.value]}</b></li>
                <li>Подача: <b>{deep.delivery.score ?? "—"}/5</b>{deep.delivery.note ? ` — ${deep.delivery.note}` : ""}</li>
                {deep.briefFit && <li>Під бриф: <b>{deep.briefFit.score}/5</b> — {deep.briefFit.reason}</li>}
              </ul>
              {deep.formats.length > 0 && <p>Формати: {deep.formats.map((f) => FORMAT_LABELS[f]).join(", ")}</p>}
              {deep.summary && <p className="muted">{deep.summary}</p>}
              {deep.transcript && (
                <details className="more"><summary>Розшифровка ({deep.transcript.language ?? "мова?"})</summary><p className="muted">{deep.transcript.text}</p></details>
              )}
            </>
          ) : <p className="muted">Глибокого аудиту ще не було — його отримують найкращі автори пошуку.</p>}
        </section>
      </div>

      <section className="card">
        <h2>Реакція аудиторії</h2>
        {comments?.metrics ? (
          <>
            <p>
              Коментарів у вибірці: <b>{comments.metrics.total}</b>{comments.free ? " (з дописів джерел, без розбору моделлю)" : ""} ·
              порожніх: <b>{pct(comments.metrics.genericShare, 0)}</b> · питань «де купити, скільки»: <b>{pct(comments.metrics.questionShare, 0)}</b> ·
              автор відповідає: <b>{pct(comments.metrics.creatorReplyShare, 0)}</b> · ті самі коментатори під різними дописами: <b>{pct(comments.metrics.repeatCommenterShare, 0)}</b>
              {comments.metrics.foreignShare != null && <> · іншою мовою: <b>{pct(comments.metrics.foreignShare, 0)}</b></>}
            </p>
            {comments.analysis && (
              <>
                <p>Тон: <b>{{ positive: "позитивний", mixed: "змішаний", negative: "негативний", unknown: "невідомо" }[comments.analysis.sentiment]}</b> ·
                  хочуть купити: <b>{TRI[comments.analysis.purchaseIntent.value]}</b> · довіряють порадам: <b>{TRI[comments.analysis.trustsCreator.value]}</b> ·
                  схоже на ботів: <b>{TRI[comments.analysis.botLike.value]}</b></p>
                <Quotes items={[...comments.analysis.purchaseIntent.evidence, ...comments.analysis.trustsCreator.evidence, ...comments.analysis.botLike.evidence].slice(0, 5)} />
                {comments.analysis.adReaction && <p>Під рекламою: {comments.analysis.adReaction.summary}</p>}
                {comments.analysis.summary && <p className="muted">{comments.analysis.summary}</p>}
              </>
            )}
            {comments.metrics.sample.length > 0 && (
              <details className="more"><summary>Приклади коментарів</summary><ul className="plain muted">{comments.metrics.sample.map((t, i) => <li key={i}>{t}</li>)}</ul></details>
            )}
          </>
        ) : <p className="muted">Коментарі не розбирались. Увімкніть «Розбір коментарів» у пошуку.</p>}
      </section>

      <section className="card">
        <h2>Контакти</h2>
        {contacts.length === 0 && c.links.length === 0 ? <p className="muted">Не знайдено.</p> : (
          <ul className="plain">
            {contacts.map((k) => <li key={k.email}><a href={`mailto:${k.email}`}>{k.email}</a> <span className="muted">· {k.status} · {k.source === "bio" ? "з біо" : k.sourceUrl} · знайдено {df.format(k.foundAt)}</span></li>)}
            {c.rates.map((r) => <li key={r.title}>прайс: {r.title} <span className="muted">({r.sourceUrl})</span></li>)}
            {c.portfolio.map((l) => <li key={l}>портфоліо: <a href={l} target="_blank" rel="noreferrer">{l}</a></li>)}
            {c.links.map((l) => <li key={l}><a href={l} target="_blank" rel="noreferrer">{l}</a></li>)}
          </ul>
        )}
      </section>

      <section className="card no-print" id="outreach">
        <h2>Листування від імені клієнта</h2>
        {threads.length > 0 && (
          <ul className="plain">
            {threads.map(({ t, client }) => (
              <li key={t.id}><Link href={`/inbox/${t.id}`}>{client}</Link> — {THREAD_LABELS[t.status]}{t.needsHuman ? <span className="risk-high"> · потрібна людина</span> : ""}</li>
            ))}
          </ul>
        )}
        {clientRows.length === 0 ? <p className="muted"><Link href="/clients">Додайте клієнта</Link> з правилами переговорів — і ІІ листуватиметься з автором від його імені.</p> : (
          <form action={startThreadAction} className="actions" style={{ alignItems: "end", marginTop: 8 }}>
            <input type="hidden" name="creatorId" value={c.id} />
            {searchId && <input type="hidden" name="searchId" value={searchId} />}
            <label>Клієнт<select name="clientId">{clientRows.map((x) => <option key={x.id} value={x.id}>{x.name}{x.mailboxId ? "" : " (без скриньки)"}</option>)}</select></label>
            <label>Адреса
              <select name="toEmail">{[...new Set([...contacts.map((k) => k.email), ...c.emails])].map((e) => <option key={e} value={e}>{e}</option>)}</select>
            </label>
            <button className="primary" disabled={contacts.length === 0 && c.emails.length === 0}>Почати листування</button>
          </form>
        )}
      </section>

      <section className="card" id="drafts">
        <h2>Листи</h2>
        <form action={createDraft} className="no-print actions" style={{ alignItems: "center" }}>
          <input type="hidden" name="id" value={c.id} />
          {searchId && <input type="hidden" name="searchId" value={searchId} />}
          <button className="primary">Написати чернетку</button>
          <span className="muted">Мова, бренд, умови й приклад тону беруться з пошуку. Модель пише лише з фактів про автора; перевірка шукає вигадані числа, посилання й імена. Надсилаєте ви самі.</span>
        </form>
        {drafts.map((d) => (
          <details key={d.id} className="more" open={d === drafts[0]} style={{ marginTop: 12 }}>
            <summary>{df.format(d.createdAt)} · {d.language} · {d.style === "example" ? "у тоні вашого прикладу" : "стандартний"}{d.issues.length ? ` · ⚠ ${d.issues.length}` : " · перевірено"}</summary>
            {d.issues.length > 0 && <ul className="plain">{d.issues.map((x) => <li key={x}>⚠ {x}</li>)}</ul>}
            {(["subject_a", "subject_b", "email", "dm", "followup_1", "followup_2"] as const).map((k) => d.data[k] ? (
              <div key={k}>
                <div className="actions" style={{ alignItems: "center", marginTop: 8 }}>
                  <b>{{ subject_a: "Тема A", subject_b: "Тема B", email: "Лист", dm: "Повідомлення в директ", followup_1: "Нагадування 1", followup_2: "Нагадування 2" }[k]}</b>
                  <CopyButton text={d.data[k]} />
                </div>
                <pre className="draft">{d.data[k]}</pre>
              </div>
            ) : null)}
          </details>
        ))}
      </section>

      {appearances.length > 0 && (
        <section className="card no-print">
          <h2>У пошуках</h2>
          <ul className="plain">
            {appearances.map((a) => (
              <li key={a.cand.id}><Link href={`/search/${a.cand.searchId}`}>{a.name}</Link> — {a.cand.stage === "qualified" ? (a.cand.lead ? "готовий лід" : "підходить") : a.cand.stage === "rejected" ? "відхилено" : "відсіяно"}, оцінка {Math.round(a.cand.score)}</li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
