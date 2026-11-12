// Створює на робочому столі ярлик «Parsing», який запускає scripts/launch.mjs,
// і вмикає автозапуск сервера під час входу в систему (Windows і Linux).
// --no-autostart — лише ярлик; автозапуск, якщо був, вимикається.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const launch = path.join(root, "scripts", "launch.mjs");
const node = process.execPath;
const autostart = !process.argv.includes("--no-autostart");

const powershell = (command) =>
  execFileSync("powershell", ["-NoProfile", "-Command", `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${command}`], { encoding: "utf8" }).trim();
const q = (s) => s.replace(/'/g, "''");

/** Ярлик Windows на node.exe; style: 1 — звичайне вікно, 7 — згорнуте. */
function windowsShortcut(file, args, style) {
  powershell(
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${q(file)}'); ` +
    `$s.TargetPath = '${q(node)}'; $s.Arguments = '${q(args)}'; $s.WorkingDirectory = '${q(root)}'; ` +
    `$s.WindowStyle = ${style}; $s.Description = 'Parsing'; $s.Save()`,
  );
}

function desktopDir() {
  if (process.env.DESKTOP_DIR) return process.env.DESKTOP_DIR;
  if (process.platform === "win32") return powershell("[Environment]::GetFolderPath('Desktop')");
  if (process.platform === "linux") {
    try {
      const dir = execFileSync("xdg-user-dir", ["DESKTOP"], { encoding: "utf8" }).trim();
      if (dir && dir !== os.homedir()) return dir;
    } catch {}
  }
  return path.join(os.homedir(), "Desktop");
}

const dir = desktopDir();
if (!existsSync(dir)) {
  console.error(`Не знайдено теку робочого столу: ${dir}. Задайте її змінною DESKTOP_DIR.`);
  process.exit(1);
}

let file;
if (process.platform === "win32") {
  file = path.join(dir, "Parsing.lnk");
  windowsShortcut(file, `"${launch}" --pause-on-error`, 1);
} else if (process.platform === "darwin") {
  file = path.join(dir, "Parsing.command");
  writeFileSync(file, `#!/bin/sh\nexec "${node}" "${launch}" --pause-on-error\n`);
  chmodSync(file, 0o755);
} else {
  file = path.join(dir, "Parsing.desktop");
  writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Parsing\nComment=Шлюз даних і пошук креаторів\nExec="${node}" "${launch}"\nPath=${root}\nIcon=applications-internet\nTerminal=false\n`);
  chmodSync(file, 0o755);
}
console.log(`Ярлик створено: ${file}`);

// Автозапуск: після ввімкнення ПК сервер піднімається сам, і http://127.0.0.1:3000 відкривається
// без ярлика (наприклад, із закладки чи відновленої вкладки браузера).
let startup = null;
if (process.platform === "win32") {
  startup = path.join(powershell("[Environment]::GetFolderPath('Startup')"), "Parsing.lnk");
  if (autostart) windowsShortcut(startup, `"${launch}" --background`, 7);
} else if (process.platform === "linux") {
  const autostartDir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "autostart");
  startup = path.join(autostartDir, "parsing.desktop");
  if (autostart) {
    mkdirSync(autostartDir, { recursive: true });
    writeFileSync(startup, `[Desktop Entry]\nType=Application\nName=Parsing (сервер)\nExec="${node}" "${launch}" --background\nPath=${root}\nTerminal=false\nNoDisplay=true\n`);
  }
}
if (startup && autostart) console.log(`Автозапуск увімкнено: ${startup}\nВимкнути — «npm run shortcut -- --no-autostart».`);
else if (startup && existsSync(startup)) {
  rmSync(startup, { force: true });
  console.log("Автозапуск вимкнено.");
}
