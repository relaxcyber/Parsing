import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { scrapeJobs, scrapeResults } from "@/db/schema";
import { ConfirmButton } from "../../keys/confirm-button";
import { AutoRefresh } from "../../search/auto-refresh";
import { STATUS } from "../../search/labels";
import { cancelJob, deleteJob, rerunJob } from "../actions";

const VIA: Record<string, string> = { local: "прямий запит", scrapling: "Scrapling", "scrapling-stealth": "Scrapling (браузер)", firecrawl: "Firecrawl" };
const cut = (v: unknown, max = 90) => {
  if (v == null || v === "") return "—";
  const chars = Array.from(String(v));
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : String(v);
};

export default async function ScrapeDetail({ params }: { params: Promise<{ id: string }> }) {
  const jobId = Number((await params).id);
  if (!Number.isInteger(jobId)) notFound();
  const db = getDb();
  const [job] = await db.select().from(scrapeJobs).where(eq(scrapeJobs.id, jobId));
  if (!job) notFound();
  const rows = await db.select().from(scrapeResults).where(eq(scrapeResults.jobId, jobId)).orderBy(asc(scrapeResults.id)).limit(500);
  const active = job.status === "queued" || job.status === "running";
  // Колонки — поля, що реально зустрілися; спершу найзаповненіші.
  const fill = new Map<string, number>();
  for (const r of rows) for (const [k, v] of Object.entries(r.data)) if (v != null && v !== "") fill.set(k, (fill.get(k) ?? 0) + 1);
  const columns = [...fill.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k).filter((k) => k !== "canonical").slice(0, 8);
  const ok = rows.filter((r) => !r.error).length;

  return (
    <>
      {active && <AutoRefresh />}
      <p className="muted"><Link href="/scrape">← Усі завдання</Link></p>
      <h1>{job.name}</h1>
      <section className="card">
        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <span className="status"><i style={{ background: STATUS[job.status].color }} /><b>{STATUS[job.status].label}</b></span>
          <span role="status">Готово {job.done} з {job.total}{job.failed ? ` · помилок: ${job.failed}` : ""}</span>
          <span style={{ marginLeft: "auto" }} className="actions">
            {active ? (
              <form action={cancelJob}><input type="hidden" name="id" value={job.id} /><button>Скасувати</button></form>
            ) : (
              <>
                <form action={rerunJob}><input type="hidden" name="id" value={job.id} /><button>{job.failed || job.done < job.total ? "Дозібрати невдалі" : "Запустити знову"}</button></form>
                {ok > 0 && <a href={`/scrape/${job.id}/export`}><button type="button">CSV</button></a>}
                {ok > 0 && <a href={`/scrape/${job.id}/export?format=json`}><button type="button">JSON</button></a>}
                <form action={deleteJob}>
                  <input type="hidden" name="id" value={job.id} />
                  <ConfirmButton question={`Видалити завдання «${job.name}» з усіма результатами?`}>Видалити</ConfirmButton>
                </form>
              </>
            )}
          </span>
        </div>
        {job.error && <p className="err" style={{ maxWidth: "none", marginBottom: 0 }} role="alert">{job.error}</p>}
      </section>

      <section className="card">
        <h2>Результати</h2>
        {rows.length === 0 ? (
          <div className="empty">{active ? "Результати з’являтимуться тут у міру збору." : "Результатів немає."}</div>
        ) : (
          <div className="scroll">
            <table>
              <thead><tr><th>Сторінка</th>{columns.map((c) => <th key={c} style={{ minWidth: 90 }}>{c}</th>)}<th>Спосіб</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td style={{ maxWidth: 260, overflowWrap: "anywhere" }}><a href={r.url} target="_blank" rel="noreferrer">{cut(r.url.replace(/^https?:\/\/(www\.)?/, ""), 60)}</a></td>
                    {r.error
                      ? <td colSpan={Math.max(1, columns.length)} className="err" style={{ maxWidth: "none" }}>{r.error}</td>
                      : columns.map((c) => <td key={c} style={{ maxWidth: 240, overflowWrap: "anywhere" }}>{cut(r.data[c])}</td>)}
                    <td className="muted">{r.via ? (VIA[r.via] ?? r.via) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted" style={{ margin: "12px 0 0" }}>У таблиці — до 8 найзаповненіших полів і перші 500 сторінок; в експорті — усі поля.</p>
      </section>
    </>
  );
}
