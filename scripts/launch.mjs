// Запускає сервер дашборда (якщо ще не працює) і відкриває його в браузері.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const port = process.env.PORT || "3000";
const url = `http://localhost:${port}`;
const win = process.platform === "win32";

const alive = async () => {
  try {
    await fetch(`${url}/login`, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
};

const run = (args) => {
  const r = spawnSync("npm", args, { cwd: root, stdio: "inherit", shell: win });
  if (r.status !== 0) {
    console.error(`\nКоманда «npm ${args.join(" ")}» завершилася з помилкою.`);
    process.exit(1);
  }
};

if (!(await alive())) {
  if (!existsSync(path.join(root, ".env"))) {
    console.error("Немає файлу .env — скопіюйте .env.example у .env і заповніть його.");
    process.exit(1);
  }
  if (!existsSync(path.join(root, "node_modules"))) run(["install"]);
  run(["run", "db:migrate"]);
  if (!existsSync(path.join(root, ".next", "BUILD_ID"))) run(["run", "build"]);

  mkdirSync(path.join(root, "data"), { recursive: true });
  const log = openSync(path.join(root, "data", "server.log"), "a");
  spawn("npm", ["start"], {
    cwd: root, detached: true, stdio: ["ignore", log, log], shell: win, windowsHide: true,
    env: { ...process.env, PORT: port },
  }).unref();

  let up = false;
  for (let i = 0; i < 60 && !(up = await alive()); i++) await new Promise((r) => setTimeout(r, 1000));
  if (!up) {
    console.error("Сервер не відповів за хвилину — дивіться data/server.log");
    process.exit(1);
  }
}

if (process.env.NO_OPEN !== "1") {
  const [cmd, args] = win ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
}
console.log(`Дашборд: ${url}`);
