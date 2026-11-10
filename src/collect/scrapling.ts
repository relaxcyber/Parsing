import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ContentItemInput } from "@/core/contract";
import { checkedItem, LocalMiss } from "./local";

/**
 * Scrapling (github.com/relaxcyber/Scrapling) — локальний обхід захисту від ботів.
 * Викликаємо його CLI: «http» імітує TLS-відбиток Chrome, «stealth» запускає
 * прихований браузер і проходить перевірку Cloudflare. Якщо Scrapling не
 * встановлено, ці ступені каскаду просто пропускаються.
 */
export class ScraplingMissing extends LocalMiss {}

const bin = () => process.env.SCRAPLING_BIN || "scrapling";

type Run = { code: number | "ENOENT" | "TIMEOUT"; output: string };

function run(args: string[], timeoutMs: number): Promise<Run> {
  return new Promise((resolve) => {
    execFile(bin(), args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err: any, stdout, stderr) => {
      const output = `${stdout}\n${stderr}`;
      if (!err) resolve({ code: 0, output });
      else if (err.code === "ENOENT") resolve({ code: "ENOENT", output });
      else if (err.killed) resolve({ code: "TIMEOUT", output });
      else resolve({ code: typeof err.code === "number" ? err.code : 1, output });
    });
  });
}

let available: { at: number; value: boolean } | undefined;

export async function scraplingAvailable(): Promise<boolean> {
  if (!available || Date.now() - available.at > 60_000) {
    available = { at: Date.now(), value: (await run(["--help"], 20_000)).code === 0 };
  }
  return available.value;
}

/** Лише для тестів: скинути кеш перевірки наявності. */
export const resetScraplingCache = () => (available = undefined);

export async function fetchScrapling(url: string, mode: "http" | "stealth"): Promise<ContentItemInput> {
  if (!(await scraplingAvailable())) throw new ScraplingMissing("Scrapling не встановлено");
  const dir = await mkdtemp(path.join(os.tmpdir(), "scrapling-"));
  const out = path.join(dir, "page.html");
  try {
    const args =
      mode === "http"
        ? ["extract", "get", url, out, "--impersonate", "chrome", "--timeout", "30"]
        : ["extract", "fetch", url, out, "--solve-cloudflare", "--network-idle", "--timeout", "60000"];
    const r = await run(args, mode === "http" ? 45_000 : 150_000);
    if (r.code === "ENOENT") throw new ScraplingMissing("Scrapling не встановлено");
    if (r.code === "TIMEOUT") throw new LocalMiss("час очікування вичерпано");
    const status = Number(r.output.match(/Fetched \((\d{3})\)/)?.[1]);
    if (status === 404 || status === 410) throw new LocalMiss(`HTTP ${status} — сторінки не існує`, true);
    if (status >= 400) throw new LocalMiss(`HTTP ${status}`);
    const html = await readFile(out, "utf8").catch(() => "");
    if (!html.trim()) throw new LocalMiss(r.code === 0 ? "порожня відповідь" : `помилка (${r.output.trim().split("\n").at(-1)?.slice(0, 160)})`);
    return checkedItem(html, url, mode === "http" ? "scrapling" : "scrapling-stealth");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
