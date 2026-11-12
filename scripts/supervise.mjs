// Сторож сервера дашборда: запускає next start і піднімає його знову, якщо процес упав або завис.
// Запускає його scripts/launch.mjs; усе, що відбувається, пишеться в data/server.log.
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, renameSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const port = process.env.PORT || "3000";
const logFile = path.join(root, "data", "server.log");
const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
const MIN_BACKOFF = 2000;

let child = null;
let startedAt = 0;
let backoff = MIN_BACKOFF;
let stopping = false;
let misses = 0;

const log = (msg) => {
  try {
    appendFileSync(logFile, `[${new Date().toLocaleString()}] [сторож] ${msg}\n`);
  } catch {}
};

function start() {
  // Журнал не росте безмежно: понад 5 МБ — відкладаємо в server.log.1 і починаємо новий.
  try {
    if (existsSync(logFile) && statSync(logFile).size > 5_000_000) renameSync(logFile, `${logFile}.1`);
  } catch {}
  const out = openSync(logFile, "a");
  startedAt = Date.now();
  misses = 0;
  child = spawn(process.execPath, [nextBin, "start", "-H", "127.0.0.1", "-p", port], {
    cwd: root, stdio: ["ignore", out, out], windowsHide: true, env: { ...process.env, PORT: port },
  });
  closeSync(out);
  log(`сервер запущено (процес ${child.pid})`);
  child.on("exit", (code, signal) => {
    child = null;
    if (stopping) return;
    const upSec = Math.round((Date.now() - startedAt) / 1000);
    if (upSec > 600) backoff = MIN_BACKOFF; // довго пропрацював — це не цикл падінь
    log(`сервер зупинився (${signal ? `сигнал ${signal}` : `код ${code}`}) після ${upSec} с роботи — перезапуск через ${backoff / 1000} с`);
    setTimeout(start, backoff);
    backoff = Math.min(backoff * 2, 60_000);
  });
}

// Завислий сервер (процес живий, але не відповідає) теж перезапускаємо. Відповідь 503 «база недоступна»
// — не зависання: сервер працює, просто чекає на мережу.
setInterval(async () => {
  if (!child || Date.now() - startedAt < 120_000) return;
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(20_000) });
    misses = 0;
  } catch {
    if (++misses >= 3) {
      log("сервер не відповідає 3 хвилини — перезапускаю");
      child.kill();
    }
  }
}, 60_000);

const stop = () => {
  stopping = true;
  child?.kill();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
start();
