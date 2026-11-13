import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createGunzip, createGzip } from "node:zlib";
import { asc, getTableColumns, getTableName, gt, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";

/**
 * Резервна копія бази: щодня файл data/backups/parsing-РРРР-ММ-ДД.jsonl.gz на ноутбуці, останні 14.
 * Без pg_dump (на Windows його немає): кожна таблиця читається порціями й пишеться рядками JSON.
 * Ключі сервісів у копії зашифровані MASTER_KEY — без файлу .env їх не прочитати, тож бережіть і його.
 * Не копіюються: кеш мовної моделі, сесії входу й журнал викликів — вони відновлюються самі.
 */

export const BACKUP_DIR = path.join(process.cwd(), "data", "backups");
const KEEP = 14;
const PAGE = 500;

/** Порядок важливий: спершу ті, на кого посилаються інші таблиці. */
export const TABLES: [string, PgTable][] = [
  ["providers", schema.providers], ["api_keys", schema.apiKeys], ["mailboxes", schema.mailboxes], ["clients", schema.clients],
  ["time_entries", schema.timeEntries], ["searches", schema.searches], ["search_templates", schema.searchTemplates],
  ["creators", schema.creators], ["creator_snapshots", schema.creatorSnapshots], ["creator_contacts", schema.creatorContacts],
  ["suppressions", schema.suppressions], ["search_candidates", schema.searchCandidates], ["content_items", schema.contentItems],
  ["collect_runs", schema.collectRuns], ["outreach_drafts", schema.outreachDrafts], ["outreach_threads", schema.outreachThreads],
  ["outreach_messages", schema.outreachMessages], ["job_pitches", schema.jobPitches], ["orders", schema.orders], ["brand_scouts", schema.brandScouts], ["eval_runs", schema.evalRuns], ["scrape_jobs", schema.scrapeJobs], ["scrape_results", schema.scrapeResults],
];

export const backupName = (d = new Date()) => `parsing-${d.toISOString().slice(0, 10)}.jsonl.gz`;

async function* lines(db: Db): AsyncGenerator<string> {
  yield `${JSON.stringify({ meta: { version: 1, createdAt: new Date().toISOString(), tables: TABLES.map(([n]) => n) } })}\n`;
  for (const [name, table] of TABLES) {
    const id = (table as any).id;
    let last = 0;
    for (;;) {
      const rows: any[] = await (db as any).select().from(table).where(gt(id, last)).orderBy(asc(id)).limit(PAGE);
      for (const r of rows) yield `${JSON.stringify({ t: name, r })}\n`;
      if (rows.length < PAGE) break;
      last = rows[rows.length - 1].id;
    }
  }
}

export async function backupDatabase(db: Db, dir = BACKUP_DIR, now = new Date()): Promise<{ file: string; bytes: number }> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, backupName(now));
  const tmp = `${file}.tmp`;
  await pipeline(Readable.from(lines(db)), createGzip(), createWriteStream(tmp));
  await rm(file, { force: true });
  await rename(tmp, file);
  // Старі копії понад 14 — видаляємо.
  const all = (await readdir(dir)).filter((f) => /^parsing-\d{4}-\d{2}-\d{2}\.jsonl\.gz$/.test(f)).sort();
  for (const f of all.slice(0, Math.max(0, all.length - KEEP))) await rm(path.join(dir, f), { force: true });
  return { file, bytes: (await stat(file)).size };
}

export async function listBackups(dir = BACKUP_DIR): Promise<{ name: string; bytes: number; at: Date }[]> {
  try {
    const names = (await readdir(dir)).filter((f) => f.endsWith(".jsonl.gz")).sort().reverse();
    return Promise.all(names.map(async (name) => {
      const s = await stat(path.join(dir, name));
      return { name, bytes: s.size, at: s.mtime };
    }));
  } catch {
    return [];
  }
}

/** Дати й час у JSON — рядки; перед вставкою повертаємо їм тип Date. */
function revive(table: PgTable, row: Record<string, unknown>) {
  const cols = getTableColumns(table);
  const out: Record<string, unknown> = {};
  for (const [key, col] of Object.entries(cols)) {
    if (!(key in row)) continue;
    const v = row[key];
    out[key] = col.columnType === "PgTimestamp" && typeof v === "string" ? new Date(v) : v;
  }
  return out;
}

/**
 * Відновлення в базу після міграцій. Якщо в базі вже є автори чи клієнти — відмова (щоб випадково
 * не змішати дві бази), хіба що force. Рядки з уже наявним id пропускаються.
 */
export async function restoreBackup(db: Db, file: string, opts: { force?: boolean } = {}): Promise<Record<string, number>> {
  if (!opts.force) {
    const [{ n }] = (await db.select({ n: sql<number>`(select count(*) from creators) + (select count(*) from clients)` }).from(schema.providers).limit(1)) as { n: number }[];
    if (Number(n) > 0) throw new Error("У базі вже є дані — відновлення скасовано. Запустіть з --force, щоб додати відсутні рядки.");
  }
  const byName = new Map(TABLES);
  const counts: Record<string, number> = {};
  const batch: { name: string; rows: Record<string, unknown>[] } = { name: "", rows: [] };
  const flush = async () => {
    if (!batch.rows.length) return;
    const table = byName.get(batch.name)!;
    await (db as any).insert(table).values(batch.rows).onConflictDoNothing();
    counts[batch.name] = (counts[batch.name] ?? 0) + batch.rows.length;
    batch.rows = [];
  };
  const rl = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as { meta?: unknown; t?: string; r?: Record<string, unknown> };
    if (rec.meta || !rec.t || !rec.r) continue;
    const table = byName.get(rec.t);
    if (!table) continue;
    if (batch.name !== rec.t) {
      await flush();
      batch.name = rec.t;
    }
    batch.rows.push(revive(table, rec.r));
    if (batch.rows.length >= 200) await flush();
  }
  await flush();
  // Лічильники id мають іти після відновлених рядків, інакше нові записи зіткнуться з ними.
  for (const [, table] of TABLES) {
    const name = getTableName(table);
    await db.execute(sql.raw(`select setval(pg_get_serial_sequence('"${name}"', 'id'), greatest((select coalesce(max(id), 0) from "${name}"), 1))`));
  }
  return counts;
}

const g = globalThis as unknown as { __backupCheckedAt?: number };

/** Для фонового виконавця: раз на годину перевіряє, чи є сьогоднішня копія, і робить її, якщо немає. */
export async function backupIfDue(db: Db): Promise<boolean> {
  if (Date.now() - (g.__backupCheckedAt ?? 0) < 3600_000) return false;
  g.__backupCheckedAt = Date.now();
  const today = backupName();
  if ((await listBackups()).some((b) => b.name === today)) return false;
  try {
    await backupDatabase(db);
  } catch (e) {
    console.error("Резервна копія не вдалася:", e);
  }
  return false;
}
