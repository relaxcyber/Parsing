// Запускає сервер дашборда (якщо ще не працює або код оновився) і відкриває його в браузері.
// --background — режим автозапуску під час входу у Windows: без браузера й без пауз, із записом
// подій у data/launch.log, і з довгим очікуванням мережі (після ввімкнення ПК її ще може не бути).
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const port = process.env.PORT || "3000";
const url = `http://127.0.0.1:${port}`;
const win = process.platform === "win32";
const data = path.join(root, "data");
const pidFile = path.join(data, "server.pid");
const builtFile = path.join(data, "built-version");
const logFile = path.join(data, "server.log");
const launchLog = path.join(data, "launch.log");
const background = process.argv.includes("--background");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Журнал запусків: у фоновому режимі вікна немає, і лише він покаже, що пішло не так. */
function note(msg) {
  try {
    appendFileSync(launchLog, `[${new Date().toLocaleString()}] ${msg}\n`);
  } catch {}
}

const fail = (msg) => {
  console.error(`\n${msg}`);
  note(`ПОМИЛКА: ${msg}`);
  // Запуск із ярлика: без паузи вікно закриється, і помилку ніхто не побачить.
  if (process.argv.includes("--pause-on-error")) {
    if (win) spawnSync("cmd", ["/c", "pause"], { stdio: "inherit" });
    else spawnSync("sh", ["-c", "printf 'Натисніть Enter… '; read _"], { stdio: "inherit" });
  }
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

/**
 * npm-команда з повторами: одразу після ввімкнення ПК Wi-Fi ще підключається, і звернення до бази
 * чи реєстру npm падає. Інтерактивно чекаємо до ~10 с, у фоні — до 5 хвилин.
 */
async function run(args, hint = "", { retries = 0, delayMs = 0 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const out = background ? openSync(launchLog, "a") : "inherit";
    const r = spawnSync("npm", args, { cwd: root, stdio: background ? ["ignore", out, out] : "inherit", shell: win, windowsHide: true });
    if (typeof out === "number") closeSync(out);
    if (r.status === 0) return;
    if (attempt >= retries) fail(`Команда «npm ${args.join(" ")}» завершилася з помилкою.${hint}`);
    const msg = `«npm ${args.join(" ")}» не вдалася, повторюю через ${Math.round(delayMs / 1000)} с (спроба ${attempt + 2} з ${retries + 1})…`;
    console.log(msg);
    note(msg);
    await sleep(delayMs);
  }
}
const netRetry = background ? { retries: 20, delayMs: 15_000 } : { retries: 2, delayMs: 5_000 };

/** Версія коду: коміт git, інакше — версія з package.json. */
function codeVersion() {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
}

function checkEnv() {
  const file = path.join(root, ".env");
  if (!existsSync(file)) fail("Немає файлу .env — виконайте «npm run setup» у теці проєкту.");
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

/**
 * Номер процесу сервера з файлу — лише якщо це справді наш процес (node). Після перезавантаження ПК
 * у файлі лишається старий номер, і Windows може віддати його іншій програмі: її чіпати не можна.
 */
function ourPid() {
  if (!existsSync(pidFile)) return null;
  const pid = Number(readFileSync(pidFile, "utf8"));
  let ours = false;
  if (Number.isInteger(pid) && pid > 0) {
    if (win) {
      const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
      ours = /"node(\.exe)?"/i.test(r.stdout ?? "");
    } else {
      try {
        ours = /node|next/.test(readFileSync(`/proc/${pid}/cmdline`, "utf8"));
      } catch {
        try {
          process.kill(pid, 0); // без /proc (macOS): лише перевірка, що процес живий
          ours = true;
        } catch {}
      }
    }
  }
  if (!ours) rmSync(pidFile, { force: true });
  return ours ? pid : null;
}

function stopServer() {
  const pid = ourPid();
  if (pid == null) return;
  try {
    if (win) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-pid, "SIGTERM"); // уся група: сторож і сам next
  } catch {}
  rmSync(pidFile, { force: true });
}

const logTail = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").slice(-15).join("\n") : "(журнал порожній)");

mkdirSync(data, { recursive: true });
// Журнал запусків дописується щодня; коли розростеться понад 1 МБ — починаємо заново.
try {
  if (existsSync(launchLog) && statSync(launchLog).size > 1_000_000) rmSync(launchLog);
} catch {}
const version = codeVersion();
const built = existsSync(builtFile) ? readFileSync(builtFile, "utf8").trim() : "";
let state = await health();
if (state?.foreign) fail(`Порт ${port} зайнятий іншою програмою. Закрийте її або задайте інший порт змінною PORT.`);
if (background) note(state ? "Автозапуск: сервер уже працює." : "Автозапуск: запускаю сервер…");

if (process.argv.includes("--stop")) {
  stopServer();
  console.log("Сервер зупинено.");
  process.exit(0);
}

const stale = built !== version || !existsSync(path.join(root, ".next", "BUILD_ID"));
if (!state || stale) {
  checkEnv();
  // Сервер, що не відповідає (завис чи ще стартує), або старий після оновлення коду — зупиняємо,
  // інакше другий сторож намагався б зайняти той самий порт.
  if (state) console.log("Код оновився — перезапускаю сервер…");
  if (state || ourPid() != null) {
    stopServer();
    for (let i = 0; i < 20 && (await health()); i++) await sleep(500);
  }
  // Залежності, міграції й збірка потрібні лише після оновлення коду. Звичайне ввімкнення ПК
  // їх пропускає, тож сервер піднімається за секунди й не чекає на інтернет.
  if (stale || !existsSync(path.join(root, "node_modules"))) {
    await run(["install"], "", netRetry);
    await run(["run", "db:migrate"], "\nНайчастіша причина — база даних недоступна. Перевірте інтернет і чи не призупинено проєкт Supabase;\nзмінити рядок підключення — «npm run setup».", netRetry);
    await run(["run", "build"]);
    writeFileSync(builtFile, version);
  }

  // Сервер працює під наглядом сторожа (scripts/supervise.mjs): упав чи завис — підніметься сам.
  const child = spawn(process.execPath, [path.join(root, "scripts", "supervise.mjs")], {
    cwd: root, detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, PORT: port },
  });
  writeFileSync(pidFile, String(child.pid));
  child.unref();

  state = null;
  for (let i = 0; i < 90 && !(state = await health()); i++) await sleep(1000);
  if (!state) fail(`Сервер не відповів за півтори хвилини. Останні рядки data/server.log:\n${logTail()}`);
}
// База може прокинутися не одразу (Supabase після простою, мережа після ввімкнення ПК).
for (let i = 0; !state.ok && i < (background ? 20 : 2); i++) {
  await sleep(background ? 15_000 : 5_000);
  state = (await health()) ?? state;
}
if (!state.ok) fail(`Сервер запущено, але є проблеми:\n- ${state.problems.join("\n- ")}`);
if (background) note(`Сервер працює: ${url}`);

if (process.env.NO_OPEN !== "1" && !background) {
  const [cmd, args] = win ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
}
console.log(`Дашборд: ${url}`);
