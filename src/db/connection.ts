import postgres from "postgres";

/**
 * Єдине місце, де відкривається з’єднання з Postgres.
 * - Транзакційний пулер Supabase (порт 6543) не підтримує підготовлені запити.
 * - Supabase вимагає TLS; вмикаємо його, якщо в адресі немає власного sslmode.
 */
export function connect(url: string, max: number, connectTimeoutSec = 30) {
  const u = new URL(url);
  const supabase = /\.supabase\.(co|com)$/.test(u.hostname);
  return postgres(url, {
    max,
    connect_timeout: connectTimeoutSec,
    prepare: u.port !== "6543",
    ...(supabase && !u.searchParams.has("sslmode") ? { ssl: "require" as const } : {}),
  });
}
