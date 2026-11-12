// Діагностика: чому дашборд не відкривається. Збирає стан у data/diagnostics.txt (без ключів і паролів),
// щоб файл можна було переслати. Запуск: «npm run doctor»; launch.mjs викликає diagnose() сам,
// коли після ввімкнення ПК сервер виявився не запущеним.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const data = path.join(root, "data");
const win = process.platform === "win32";
export const reportFile = path.join(data, "diagnostics.txt");

const sh = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
};
const ps = (command) => sh("powershell", ["-NoProfile", "-Command", `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${command}`]);

/** Прибирає з журналів рядки підключення до бази й ключі сервісів. */
export const redact = (s) =>
  s
    .replace(/(postgres(?:ql)?:\/\/)[^@\s]+@/gi, "$1***@")
    .replace(/\b(apify_api_|gsk_|fc-|sk-|AIza)[A-Za-z0-9_-]{8,}/g, "$1***")
    .replace(/((?:PASSWORD|MASTER_KEY|TOKEN|SECRET)\s*[=:]\s*)\S+/gi, "$1***");

const tail = (file, n) => {
  if (!existsSync(file)) return "(файлу немає)";
  return redact(readFileSync(file, "utf8").trim().split(/\r?\n/).slice(-n).join("\n")) || "(порожньо)";
};
const stamp = (file) => (existsSync(file) ? statSync(file).mtime.toLocaleString() : "немає");

async function health(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(8000) });
    return `HTTP ${res.status} ${(await res.text()).slice(0, 400)}`;
  } catch (e) {
    return `не відповідає (${e?.cause?.code ?? e?.name ?? e})`;
  }
}

function autostartInfo() {
  if (win) {
    const dir = ps("[Environment]::GetFolderPath('Startup')");
    const lnk = path.join(dir, "Parsing.lnk");
    if (!existsSync(lnk)) return `Ярлика автозапуску немає (${lnk}). Запустіть Install-Parsing.cmd ще раз.`;
    const target = ps(`$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}'); "$($s.TargetPath) $($s.Arguments)"`);
    // Вимкнений у «Диспетчер завдань → Автозавантаження» запис позначається тут непарним першим байтом.
    const approved = sh("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder", "/v", "Parsing.lnk"]);
    const m = approved.match(/REG_BINARY\s+([0-9A-F]{2})/i);
    const off = m && parseInt(m[1], 16) % 2 === 1;
    return `Ярлик: ${lnk}\nЗапускає: ${target}\nУ диспетчері завдань: ${m ? (off ? "ВИМКНЕНО — увімкніть «Parsing» у Диспетчер завдань → Автозавантаження" : "увімкнено") : "без позначки (увімкнено)"}`;
  }
  const file = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "autostart", "parsing.desktop");
  return existsSync(file) ? `Файл автозапуску: ${file}` : "Автозапуск не налаштовано (npm run shortcut).";
}

export async function diagnose({ reason = "" } = {}) {
  const port = process.env.PORT || "3000";
  const head = sh("git", ["-C", root, "rev-parse", "--short", "HEAD"]);
  const built = existsSync(path.join(data, "built-version")) ? readFileSync(path.join(data, "built-version"), "utf8").trim().slice(0, 7) : "немає";
  const pid = existsSync(path.join(data, "server.pid")) ? readFileSync(path.join(data, "server.pid"), "utf8").trim() : "немає";
  const lines = [
    `Діагностика Parsing — ${new Date().toLocaleString()}`,
    reason && `Привід: ${reason}`,
    "",
    `Система: ${os.type()} ${os.release()}, Node ${process.versions.node}, тека ${root}`,
    `Увімкнено: ${win ? ps("(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToString('dd.MM.yyyy HH:mm:ss')") : new Date(Date.now() - os.uptime() * 1000).toLocaleString()}`,
    `Код: ${head || "?"}, зібрано: ${built}, збірка .next: ${existsSync(path.join(root, ".next", "BUILD_ID")) ? "є" : "НЕМАЄ"}, node_modules: ${existsSync(path.join(root, "node_modules")) ? "є" : "НЕМАЄ"}, .env: ${existsSync(path.join(root, ".env")) ? "є" : "НЕМАЄ"}`,
    `Сервер на порту ${port}: ${redact(await health(port))}`,
    `Файл процесу: ${pid}`,
    `Процеси node: ${win ? sh("tasklist", ["/FI", "IMAGENAME eq node.exe", "/FO", "CSV", "/NH"]).split(/\r?\n/).filter((l) => l.includes("node")).length : sh("pgrep", ["-c", "node"]) || "0"}`,
    win ? `Порт ${port}: ${sh("cmd", ["/c", `netstat -ano | findstr :${port}`]) || "ніхто не слухає"}` : "",
    "",
    "== Автозапуск ==",
    autostartInfo(),
    "",
    `== data/launch.log (змінено ${stamp(path.join(data, "launch.log"))}) ==`,
    tail(path.join(data, "launch.log"), 40),
    "",
    `== data/server.log (змінено ${stamp(path.join(data, "server.log"))}) ==`,
    tail(path.join(data, "server.log"), 60),
  ];
  const text = lines.filter((l) => l !== false && l !== undefined).join("\n") + "\n";
  writeFileSync(reportFile, text);
  return text;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  console.log(await diagnose({ reason: "запуск вручну" }));
  console.log(`Збережено: ${reportFile}\nНадішліть цей файл, якщо дашборд не відкривається.`);
  if (process.argv.includes("--pause") && win) {
    // Відкриваємо теку з виділеним файлом — його зручно перетягнути в чат.
    spawnSync("explorer", [`/select,${reportFile}`]);
    spawnSync("cmd", ["/c", "pause"], { stdio: "inherit" });
  }
}
