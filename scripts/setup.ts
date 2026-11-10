/**
 * Перше налаштування: питає рядок підключення до бази та пароль дашборда,
 * перевіряє з’єднання, генерує MASTER_KEY і записує .env.
 *   npm run setup
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { connect } from "../src/db/connection";

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

async function askDatabase(): Promise<string> {
  console.log("\n1) База даних");
  console.log("   Supabase: відкрийте проєкт → кнопка Connect → вкладка «Session pooler» → скопіюйте рядок");
  console.log("   і замініть [YOUR-PASSWORD] на пароль бази.");
  for (;;) {
    const hint = current.DATABASE_URL ? " (Enter — залишити поточний)" : "";
    const value = (await ask(`   Рядок підключення${hint}: `)) || current.DATABASE_URL || "";
    if (!URL.canParse(value) || !/^postgres(ql)?:$/.test(new URL(value).protocol)) {
      console.log("   Це не схоже на рядок підключення: він починається з postgresql://\n");
      continue;
    }
    if (/\[YOUR-PASSWORD\]|%5BYOUR-PASSWORD%5D/i.test(value)) {
      console.log("   У рядку лишився шаблон [YOUR-PASSWORD] — замініть його на справжній пароль бази.\n");
      continue;
    }
    process.stdout.write("   Перевіряю з’єднання… ");
    const sql = connect(value, 1);
    try {
      await sql`select 1`;
      console.log("працює.");
      return value;
    } catch (e) {
      console.log(`не вдалося.\n   ${explain(e, new URL(value)).replace(/\n/g, "\n   ")}\n`);
    } finally {
      await sql.end({ timeout: 2 }).catch(() => {});
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
