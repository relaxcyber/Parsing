/** Допоміжні функції для підключення до Supabase без ручного складання рядка. */

const REGIONS = [
  "eu-central-1", "eu-west-1", "eu-west-2", "eu-west-3", "eu-north-1", "eu-central-2",
  "us-east-1", "us-east-2", "us-west-1", "us-west-2", "ca-central-1", "sa-east-1",
  "ap-south-1", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1", "ap-northeast-2",
];

/** Ідентифікатор проєкту з «abcd…» або «https://abcd….supabase.co»; null, якщо це щось інше. */
export function parseProjectRef(input: string): string | null {
  const m = input.trim().match(/^(?:https?:\/\/)?([a-z0-9]{20})(?:\.supabase\.co\/?.*)?$/i);
  return m ? m[1].toLowerCase() : null;
}

const build = (user: string, password: string, host: string, port: number) =>
  `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/postgres`;

/** Можливі адреси бази проєкту: пулери всіх регіонів (IPv4), наостанок — пряме з’єднання (лише IPv6). */
export function connectionCandidates(ref: string, password: string): string[] {
  const poolers = ["aws-0", "aws-1"].flatMap((p) => REGIONS.map((r) => build(`postgres.${ref}`, password, `${p}-${r}.pooler.supabase.com`, 5432)));
  return [...poolers, build("postgres", password, `db.${ref}.supabase.co`, 5432)];
}

/**
 * Рядок, вставлений із панелі, де пароль може містити @ : / # ? без кодування.
 * Пароль — усе між першим «:» після логіна й ОСТАННІМ «@»; кодуємо його заново.
 */
export function normalizeConnectionString(raw: string): string | null {
  const m = raw.trim().match(/^(postgres(?:ql)?:\/\/)([^:@/]+):(.*)@([^@/]+)(\/.*)?$/s);
  if (!m) return null;
  const [, scheme, user, password, hostPort, rest = "/postgres"] = m;
  let plain = password;
  try {
    plain = decodeURIComponent(password); // уже закодований пароль не кодуємо вдруге
  } catch {}
  const url = `${scheme}${user}:${encodeURIComponent(plain)}@${hostPort}${rest}`;
  return URL.canParse(url) ? url : null;
}

export type Probe = (url: string) => Promise<void>;
export type Discovery = { url: string } | { error: "password" | "not-found" | "network"; detail: string };

/** Пробує всі адреси одночасно й повертає першу робочу в порядку пріоритету. */
export async function discoverConnection(ref: string, password: string, probe: Probe): Promise<Discovery> {
  const candidates = connectionCandidates(ref, password);
  const results = await Promise.all(candidates.map((url) => probe(url).then(() => null, (e) => String(e?.message ?? e))));
  const ok = results.findIndex((r) => r === null);
  if (ok >= 0) return { url: candidates[ok] };
  const errors = results as string[];
  const wrongPassword = errors.find((e) => /password authentication failed|SASL/i.test(e));
  if (wrongPassword) return { error: "password", detail: wrongPassword };
  if (errors.some((e) => /Tenant or user not found/i.test(e))) return { error: "not-found", detail: "Tenant or user not found" };
  return { error: "network", detail: errors.at(-1) ?? "" };
}
