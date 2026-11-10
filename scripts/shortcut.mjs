// Створює на робочому столі ярлик «Parsing», який запускає scripts/launch.mjs.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const launch = path.join(root, "scripts", "launch.mjs");
const node = process.execPath;

function desktopDir() {
  if (process.env.DESKTOP_DIR) return process.env.DESKTOP_DIR;
  if (process.platform === "win32") {
    return execFileSync("powershell", ["-NoProfile", "-Command", "[Environment]::GetFolderPath('Desktop')"], { encoding: "utf8" }).trim();
  }
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
  const q = (s) => s.replace(/'/g, "''");
  execFileSync("powershell", ["-NoProfile", "-Command",
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${q(file)}'); ` +
    `$s.TargetPath = '${q(node)}'; $s.Arguments = '"${q(launch)}" --pause-on-error'; $s.WorkingDirectory = '${q(root)}'; ` +
    `$s.WindowStyle = 1; $s.Description = 'Parsing'; $s.Save()`]);
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
