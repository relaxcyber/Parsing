import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import type { AdsReport } from "@/analysis/ads";
import type { TrustReport } from "@/analysis/trust";
import { auditView } from "@/audit/vision";
import { getDb } from "@/db/client";
import { creators, searchCandidates, searches } from "@/db/schema";
import { PrintButton } from "../../../creators/print-button";

const nf = new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 0 });
const df = new Intl.DateTimeFormat("uk-UA", { day: "2-digit", month: "long", year: "numeric" });
const RISK: Record<string, string> = { low: "низький", medium: "середній", high: "високий", unknown: "не оцінено" };

/** Звіт для клієнта: шорт-лист із поясненням, чому обрано кожного автора. Друкується або зберігається в PDF. */
export default async function ClientReport({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ all?: string }> }) {
  const searchId = Number((await params).id);
  if (!Number.isInteger(searchId)) notFound();
  const all = (await searchParams).all === "1";
  const db = getDb();
  const [s] = await db.select().from(searches).where(eq(searches.id, searchId));
  if (!s) notFound();
  const rows = await db.select({ cand: searchCandidates, c: creators }).from(searchCandidates)
    .innerJoin(creators, eq(searchCandidates.creatorId, creators.id))
    .where(and(eq(searchCandidates.searchId, searchId), eq(searchCandidates.stage, "qualified"), all ? undefined : eq(searchCandidates.lead, true)))
    .orderBy(desc(searchCandidates.score)).limit(100);
  const st = s.stats;

  return (
    <>
      <div className="actions no-print" style={{ marginBottom: 12 }}>
        <Link href={`/search/${s.id}`}><button type="button">← До пошуку</button></Link>
        <PrintButton label="Друк / зберегти PDF" />
        <Link href={`/search/${s.id}/report${all ? "" : "?all=1"}`}><button type="button">{all ? "Лише готові ліди" : "Усі, хто підходить"}</button></Link>
      </div>
      <h1>Шорт-лист креаторів: {s.brandName ?? s.name}</h1>
      <p className="sub">
        {df.format(s.finishedAt ?? s.createdAt)} · переглянуто авторів: {st.authors ?? "—"}, профілів: {(st.profilesFetched ?? 0) + (st.profilesReused ?? 0)},
        {" "}пройшли відбір: {st.qualified ?? "—"}, у списку: {rows.length}
      </p>
      {s.brief && <section className="card"><h2>Завдання</h2><p style={{ whiteSpace: "pre-wrap" }}>{s.brief}</p></section>}
      <section className="card">
        <h2>Як відбирали</h2>
        <p className="muted">
          Кожен автор пройшов: відсів магазинів, агенцій і неактивних; перевірку аудиторії на ознаки накрутки (залученість проти норми для
          розміру акаунта, співвідношення коментарів і вподобань, підписки, стрибки підписників); аналіз біо й підписів (кожен висновок
          підтверджено цитатою); оцінку якості зйомки за кадрами; для найкращих — розбір роликів (зачіпка, товар у дії, заклик, субтитри).
        </p>
      </section>
      {rows.length === 0 ? <section className="card"><div className="empty">У списку нікого.</div></section> : rows.map(({ cand, c }, i) => {
        const audit = auditView(c.audit);
        const trust = c.trust as TrustReport | null;
        const ads = c.ads as AdsReport | null;
        const why = cand.reasons.filter((r) => !r.startsWith("мінус") && !/^(аудит|аналіз|коментарі|розбір)/.test(r)).slice(0, 6);
        const minus = cand.reasons.filter((r) => r.startsWith("мінус")).map((r) => r.replace(/^мінус: /, "")).slice(0, 3);
        return (
          <section className="card" key={cand.id}>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              {c.quality != null && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/media/collage/${c.id}`} alt={`Роботи @${c.username}`} width={150} height={150} className="collage" />
              )}
              <div style={{ flex: 1, minWidth: 260 }}>
                <h2 style={{ marginBottom: 4 }}>{i + 1}. @{c.username} {c.displayName ? <span className="muted">· {c.displayName}</span> : null}</h2>
                <p className="muted" style={{ marginTop: 0 }}>
                  instagram.com/{c.username} · {c.followers != null ? `${nf.format(c.followers)} підписників` : ""}
                  {c.erLikes != null ? ` · залученість ${(c.erLikes * 100).toFixed(1)}%` : ""}
                  {trust?.norm ? ` (норма ${(trust.norm.erLikes * 100).toFixed(1)}%)` : ""}
                  {c.country ? ` · ${c.country}` : ""}{c.language ? ` · ${c.language}` : ""}
                </p>
                <p>
                  Оцінка <b>{Math.round(cand.score)}</b>/100 · якість зйомки {cand.quality != null ? Math.round(cand.quality) : "—"}
                  {c.adQuality != null ? ` · рекламна подача ${Math.round(c.adQuality)}` : ""} · ризик накрутки: {RISK[c.trustRisk ?? "unknown"]}
                  {ads && ads.adPosts > 0 ? ` · реклама в ${ads.adPosts} з ${ads.posts} дописів` : ""}
                </p>
                {audit?.summary && <p>{audit.summary}</p>}
                {why.length > 0 && <p><b>Чому обрано:</b> {why.join("; ")}.</p>}
                {minus.length > 0 && <p className="muted"><b>Зверніть увагу:</b> {minus.join("; ")}.</p>}
              </div>
            </div>
          </section>
        );
      })}
      <p className="muted print-only">Підготовлено в Parsing. Цифри — на дату збору; аудиторію автора (країна, вік) варто підтвердити скриншотом статистики.</p>
    </>
  );
}
