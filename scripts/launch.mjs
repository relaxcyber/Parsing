// Запускає сервер дашборда (якщо ще не працює або код оновився) і відкриває його в браузері.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const port = process.env.PORT || "3000";
const url = `http://127.0.0.1:${port}`;
const win = process.platform === "win32";
const data = path.join(root, "data");
const pidFile = path.join(data, "server.pid");
const builtFile = path.join(data, "built-version");
const logFile = path.join(data, "server.log");

const fail = (msg) => {
  console.error(`\n${msg}`);
  process.exit(1);
};

/** Стан сервера: null — ніхто не відповідає; інакше відповідь /api/health (чи чужий застосунок). */
async function health() {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5000) });
    const body = await res.json().catch(() => null);
    return body?.app === "parsing" ? body : { foreign: true };
  } catch {
    return null;
  }
}

const run = (args) => {
  const r = spawnSync("npm", args, { cwd: root, stdio: "inherit", shell: win });
  if (r.status !== 0) fail(`Команда «npm ${args.join(" ")}» завершилася з помилкою.`);
};

/** Версія коду: коміт git, інакше — версія з package.json. */
function codeVersion() {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
}

function checkEnv() {
  const file = path.join(root, ".env");
  if (!existsSync(file)) fail("Немає файлу .env — скопіюйте .env.example у .env і заповніть його.");
  const env = Object.fromEntries(
    readFileSync(file, "utf8").split(/\r?\n/).filter((l) => /^\s*[A-Z_]+=/.test(l)).map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
  );
  const missing = ["DATABASE_URL", "MASTER_KEY", "DASHBOARD_PASSWORD"].filter((k) => !env[k]);
  if (missing.length) fail(`У .env не заповнено: ${missing.join(", ")}`);
  if (env.MASTER_KEY.length < 16) fail("MASTER_KEY у .env має бути не коротшим за 16 символів.");
}

function stopServer() {
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8"));
  try {
    if (win) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"]);
    else process.kill(-pid, "SIGTERM"); // уся група: npm і сам next
  } catch {}
  rmSync(pidFile, { force: true });
}

const logTail = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").slice(-15).join("\n") : "(журнал порожній)");

mkdirSync(data, { recursive: true });
const version = codeVersion();
const built = existsSync(builtFile) ? readFileSync(builtFile, "utf8").trim() : "";
let state = await health();
if (state?.foreign) fail(`Порт ${port} зайнятий іншою програмою. Закрийте її або задайте інший порт змінною PORT.`);

if (process.argv.includes("--stop")) {
  stopServer();
  console.log("Сервер зупинено.");
  process.exit(0);
}

const stale = built !== version || !existsSync(path.join(root, ".next", "BUILD_ID"));
if (!state || stale) {
  checkEnv();
  if (state) {
    console.log("Код оновився — перезапускаю сервер…");
    stopServer();
    for (let i = 0; i < 20 && (await health()); i++) await new Promise((r) => setTimeout(r, 500));
  }
  if (!existsSync(path.join(root, "node_modules")) || stale) run(["install"]);
  run(["run", "db:migrate"]);
  if (stale) {
    run(["run", "build"]);
    writeFileSync(builtFile, version);
  }

  const log = openSync(logFile, "w"); // новий запуск — новий журнал, файл не росте безмежно
  const child = spawn("npm", ["start"], {
    cwd: root, detached: true, stdio: ["ignore", log, log], shell: win, windowsHide: true,
    env: { ...process.env, PORT: port },
  });
  writeFileSync(pidFile, String(child.pid));
  child.unref();

  state = null;
  for (let i = 0; i < 60 && !(state = await health()); i++) await new Promise((r) => setTimeout(r, 1000));
  if (!state) fail(`Сервер не відповів за хвилину. Останні рядки data/server.log:\n${logTail()}`);
}
if (!state.ok) fail(`Сервер запущено, але є проблеми:\n- ${state.problems.join("\n- ")}`);

if (process.env.NO_OPEN !== "1") {
  const [cmd, args] = win ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
}
console.log(`Дашборд: ${url}`);
