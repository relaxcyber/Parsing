/**
 * Перше налаштування: питає рядок підключення до бази та пароль дашборда,
 * перевіряє з’єднання, генерує MASTER_KEY і записує .env.
 *   npm run setup
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { connect } from "../src/db/connection";
import { discoverConnection, normalizeConnectionString, parseProjectRef } from "../src/db/supabase";

const FILE = ".env";
const current: Record<string, string> = {};
if (existsSync(FILE)) {
  for (const line of readFileSync(FILE, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)=(.*)$/);
    if (m) current[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const lines = rl[Symbol.asyncIterator]();
// Читаємо рядками, щоб працювало і в терміналі, і при вставці кількох відповідей одразу.
const ask = async (q: string) => {
  process.stdout.write(q);
  const { value, done } = await lines.next();
  if (done) throw new Error("Введення перервано");
  return String(value).trim();
};

/** Пояснення типових помилок підключення людською мовою. */
function explain(e: any, url: URL): string {
  const msg = String(e?.message ?? e);
  if (/password authentication failed|SASL|Tenant or user not found/i.test(msg)) {
    return "База відхилила логін або пароль. Перевірте пароль бази (Supabase: Project Settings → Database → Reset database password).\n" +
      "Якщо в паролі є символи @ : / ? # % — замініть пароль на простіший (літери й цифри) або закодуйте їх.";
  }
  if (/ENOTFOUND|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN/i.test(msg)) {
    return url.hostname.startsWith("db.")
      ? "Адреса «db.….supabase.co» працює лише через IPv6. Скопіюйте рядок із вкладки «Session pooler» (хост …pooler.supabase.com)."
      : "Не вдалося знайти сервер бази. Перевірте адресу та інтернет-з’єднання.";
  }
  if (/ECONNREFUSED|timeout|ETIMEDOUT/i.test(msg)) return "Сервер бази не відповідає. Перевірте адресу, порт і чи не призупинено проєкт Supabase.";
  return msg;
}

async function works(url: string, timeoutSec = 30): Promise<void> {
  const sql = connect(url, 1, timeoutSec);
  try {
    await sql`select 1`;
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }
}

const argRef = (() => {
  const i = process.argv.indexOf("--supabase");
  return i > 0 ? parseProjectRef(process.argv[i + 1] ?? "") : null;
})();

/** Supabase за ідентифікатором проєкту: питаємо лише пароль бази, адресу знаходимо самі. */
async function fromProject(ref: string): Promise<string | null> {
  for (;;) {
    const password = await ask(`   Пароль бази проєкту ${ref} (Enter — ввести рядок підключення вручну): `);
    if (!password) return null;
    process.stdout.write("   Шукаю базу проєкту… ");
    const found = await discoverConnection(ref, password, (url) => works(url, 10));
    if ("url" in found) {
      console.log(`знайдено (${new URL(found.url).hostname}).`);
      return found.url;
    }
    console.log("не вдалося.");
    if (found.error === "password") console.log("   Пароль не підійшов. Його можна скинути в Supabase: Project Settings → Database → Reset database password.\n");
    else if (found.error === "not-found") console.log("   Проєкт із таким ідентифікатором не знайдено або його призупинено — відкрийте панель Supabase і за потреби натисніть Restore.\n");
    else console.log(`   Немає зв’язку із Supabase. Перевірте інтернет. (${found.detail.slice(0, 120)})\n`);
  }
}

async function askDatabase(): Promise<string> {
  console.log("\n1) База даних");
  if (argRef) {
    const url = await fromProject(argRef);
    if (url) return url;
  }
  console.log("   Supabase: введіть адресу проєкту (https://….supabase.co) — далі знадобиться лише пароль бази.");
  console.log("   Або вставте повний рядок підключення (postgresql://…).");
  for (;;) {
    const hint = current.DATABASE_URL ? " (Enter — залишити поточний)" : "";
    const input = (await ask(`   Адреса проєкту або рядок підключення${hint}: `)) || current.DATABASE_URL || "";
    const ref = parseProjectRef(input);
    if (ref) {
      const url = await fromProject(ref);
      if (url) return url;
      continue;
    }
    if (/\[YOUR-PASSWORD\]|%5BYOUR-PASSWORD%5D/i.test(input)) {
      console.log("   У рядку лишився шаблон [YOUR-PASSWORD] — замініть його на справжній пароль бази.\n");
      continue;
    }
    // Пароль зі спецсимволами (@ # : /) кодуємо самі — вручну це роблять з помилками.
    const value = normalizeConnectionString(input);
    if (!value) {
      console.log("   Не розпізнано. Потрібна адреса проєкту Supabase або рядок, що починається з postgresql://\n");
      continue;
    }
    process.stdout.write("   Перевіряю з’єднання… ");
    try {
      await works(value);
      console.log("працює.");
      return value;
    } catch (e) {
      console.log(`не вдалося.\n   ${explain(e, new URL(value)).replace(/\n/g, "\n   ")}\n`);
    }
  }
}

async function askPassword(): Promise<string> {
  console.log("\n2) Пароль для входу в дашборд");
  for (;;) {
    const hint = current.DASHBOARD_PASSWORD ? " (Enter — залишити поточний)" : "";
    const value = (await ask(`   Пароль, щонайменше 8 символів${hint}: `)) || current.DASHBOARD_PASSWORD || "";
    if (value.length >= 8) return value;
    console.log("   Закороткий.\n");
  }
}

const DATABASE_URL = await askDatabase();
const DASHBOARD_PASSWORD = await askPassword();
const MASTER_KEY = current.MASTER_KEY && current.MASTER_KEY.length >= 16 ? current.MASTER_KEY : randomBytes(32).toString("base64");
rl.close();

const extra = Object.entries(current).filter(([k]) => !["DATABASE_URL", "MASTER_KEY", "DASHBOARD_PASSWORD"].includes(k));
writeFileSync(
  FILE,
  [
    `DATABASE_URL=${DATABASE_URL}`,
    "# Ним зашифровано API-ключі в базі. Не змінюйте і збережіть копію цього файлу.",
    `MASTER_KEY=${MASTER_KEY}`,
    `DASHBOARD_PASSWORD=${DASHBOARD_PASSWORD}`,
    ...extra.map(([k, v]) => `${k}=${v}`),
    "",
  ].join("\n"),
);
console.log("\nГотово: налаштування записано у файл .env.");
console.log("Збережіть його копію в надійному місці — без MASTER_KEY збережені API-ключі не відновити.");
console.log("Далі: «npm run shortcut», потім двічі клацніть ярлик «Parsing» на робочому столі.");
process.exit(0);
