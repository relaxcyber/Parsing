import { eq, sql } from "drizzle-orm";
import { fetchFirecrawl } from "@/collect/firecrawl";
import { getPageHtml } from "@/collect/html";
import { extractHtml } from "@/collect/local";
import { normalizeUrl } from "@/collect/net";
import type { Db } from "@/db/client";
import { scrapeJobs, scrapeResults, type ScrapeJob } from "@/db/schema";
import { aiExtract, autoExtract, selectorExtract, type Row } from "./extract";

export const MAX_URLS = 500;

/** Список адрес із тексту форми: по одній на рядок, без дублів і сміття. */
export function parseUrls(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s,]+/)) {
    const line = raw.trim();
    if (!/^https?:\/\//i.test(line) || !URL.canParse(line)) continue;
    const url = normalizeUrl(line);
    if (!out.includes(url)) out.push(url);
  }
  return out.slice(0, MAX_URLS);
}

/** Адреси з карти сайту (sitemap.xml), включно з вкладеними картами першого рівня. */
async function expandSitemap(url: string, depth = 0): Promise<string[]> {
  const page = await getPageHtml(url).catch(() => null);
  if (!page || "error" in page) return [];
  const locs = [...page.html.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
  if (depth === 0 && /<sitemapindex/i.test(page.html)) {
    const nested: string[] = [];
    for (const child of locs.slice(0, 5)) nested.push(...(await expandSitemap(child, 1)));
    return nested;
  }
  return locs.filter((l) => !/\.xml(\.gz)?$/i.test(l));
}

async function scrapeOne(db: Db, job: ScrapeJob, url: string): Promise<{ data: Row; via: string } | { error: string }> {
  let page;
  try {
    page = await getPageHtml(url);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  if (!("error" in page)) {
    if (job.mode === "selectors") return { data: selectorExtract(page.html, job.fields), via: page.via };
    if (job.mode === "ai") return { data: await aiExtract(db, extractHtml(page.html, url).text ?? "", job.fields.map((f) => f.name)), via: page.via };
    return { data: autoExtract(page.html, url), via: page.via };
  }
  if (!job.allowPaid) return { error: page.error };
  // Firecrawl віддає текст, а не розмітку: селектори тут не спрацюють, тож лише текстові режими.
  if (job.mode === "selectors") return { error: `${page.error} (Firecrawl не дає HTML для селекторів)` };
  const item = await fetchFirecrawl(db, url);
  if (job.mode === "ai") return { data: await aiExtract(db, item.text ?? "", job.fields.map((f) => f.name)), via: "firecrawl" };
  return { data: { type: "page", title: item.title ?? null, description: (item.text ?? "").slice(0, 500) || null, image: item.media?.[0]?.url ?? null, canonical: url }, via: "firecrawl" };
}

/** Виконує завдання: до трьох сторінок одночасно, з паузою між запитами до одного сайту. */
export async function runScrapeJob(db: Db, jobId: number): Promise<void> {
  const [job] = await db.select().from(scrapeJobs).where(eq(scrapeJobs.id, jobId));
  if (!job) return;
  try {
    let urls = job.urls;
    const maps = urls.filter((u) => /sitemap[^/]*\.xml(\.gz)?$|\.xml$/i.test(new URL(u).pathname));
    if (maps.length) {
      const expanded: string[] = urls.filter((u) => !maps.includes(u));
      for (const m of maps) for (const u of await expandSitemap(m)) if (URL.canParse(u) && !expanded.includes(u)) expanded.push(u);
      urls = expanded.slice(0, MAX_URLS);
      await db.update(scrapeJobs).set({ urls }).where(eq(scrapeJobs.id, jobId));
    }
    const doneRows = await db.select({ url: scrapeResults.url, error: scrapeResults.error }).from(scrapeResults).where(eq(scrapeResults.jobId, jobId));
    // Повторний запуск добирає лише те, чого ще немає, і те, що минулого разу не вдалося.
    const already = new Set(doneRows.filter((r) => !r.error).map((r) => r.url));
    const todo = urls.filter((u) => !already.has(u));
    await db.update(scrapeJobs).set({ total: urls.length, done: already.size, failed: 0 }).where(eq(scrapeJobs.id, jobId));

    const lastHit = new Map<string, number>();
    let next = 0;
    let cancelled = false;
    await Promise.all(Array.from({ length: Math.min(3, todo.length) }, async () => {
      while (next < todo.length && !cancelled) {
        const url = todo[next++];
        const host = new URL(url).hostname;
        const wait = (lastHit.get(host) ?? 0) + 700 - Date.now();
        lastHit.set(host, Date.now() + Math.max(0, wait));
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        let result: Awaited<ReturnType<typeof scrapeOne>>;
        try {
          result = await scrapeOne(db, job, url);
        } catch (e) {
          result = { error: (e instanceof Error ? e.message : String(e)).slice(0, 500) };
        }
        const values = "error" in result
          ? { jobId, url, data: {}, via: null, error: result.error.slice(0, 500), fetchedAt: new Date() }
          : { jobId, url, data: result.data, via: result.via, error: null, fetchedAt: new Date() };
        await db.insert(scrapeResults).values(values).onConflictDoUpdate({
          target: [scrapeResults.jobId, scrapeResults.url],
          set: { data: sql`excluded.data`, via: sql`excluded.via`, error: sql`excluded.error`, fetchedAt: sql`excluded.fetched_at` },
        });
        const [row] = await db.update(scrapeJobs)
          .set({ done: sql`${scrapeJobs.done} + ${"error" in result ? 0 : 1}`, failed: sql`${scrapeJobs.failed} + ${"error" in result ? 1 : 0}` })
          .where(eq(scrapeJobs.id, jobId)).returning({ status: scrapeJobs.status });
        if (row?.status === "cancelled") cancelled = true;
      }
    }));
    if (!cancelled) await db.update(scrapeJobs).set({ status: "done", finishedAt: new Date(), error: null }).where(eq(scrapeJobs.id, jobId));
  } catch (e) {
    await db.update(scrapeJobs).set({ status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 2000), finishedAt: new Date() }).where(eq(scrapeJobs.id, jobId));
  }
}

export async function runNextScrapeJob(db: Db): Promise<boolean> {
  const [next] = await db.update(scrapeJobs).set({ status: "running", error: null })
    .where(eq(scrapeJobs.id, sql`(select id from scrape_jobs where status = 'queued' order by created_at limit 1 for update skip locked)`))
    .returning({ id: scrapeJobs.id });
  if (!next) return false;
  await runScrapeJob(db, next.id);
  return true;
}

export async function requeueInterruptedJobs(db: Db): Promise<void> {
  await db.update(scrapeJobs).set({ status: "queued" }).where(eq(scrapeJobs.status, "running"));
}
