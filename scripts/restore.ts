// Відновлення бази з резервної копії: npm run restore -- data/backups/parsing-2026-11-13.jsonl.gz [--force]
// Спершу застосуйте міграції (npm run db:migrate) — таблиці мають існувати.
import { getDb } from "@/db/client";
import { restoreBackup } from "@/backup";

const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!file) {
  console.error("Вкажіть файл копії: npm run restore -- data/backups/parsing-РРРР-ММ-ДД.jsonl.gz");
  process.exit(1);
}
try {
  const counts = await restoreBackup(getDb(), file, { force: process.argv.includes("--force") });
  console.log("Відновлено рядків:", counts);
  process.exit(0);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
