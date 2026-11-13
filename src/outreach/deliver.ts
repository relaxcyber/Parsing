import { resolveTxt } from "node:dns/promises";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { creatorContacts, mailboxes, outreachMessages, type DomainCheck, type Mailbox } from "@/db/schema";
import { NoKeyAvailableError, ProviderHttpError, withKey } from "@/keys/router";

/**
 * Доставлюваність: щоб листи не потрапляли в спам і скриньки не «згоріли».
 *  - адреса перевіряється сервісом перед першим листом (неіснуючі — не надсилаємо);
 *  - скринька розганяється поступово (5 листів на добу + 2 щодня до вашого ліміту);
 *  - забагато недоставлених листів чи помилок надсилання — скринька зупиняється;
 *  - SPF, DKIM і DMARC домену відправника перевіряються під час підключення.
 */

const DAY = 86_400_000;
export const BOUNCE_LIMIT = 0.05;
const BOUNCE_MIN_SENT = 10;
export const WARMUP_START = 5;
export const WARMUP_STEP = 2;
const VERIFY_FRESH_MS = 30 * DAY;

/* ---------- перевірка адреси сервісом ---------- */

export type Verdict = "valid" | "invalid" | "risky" | "unknown";

type Service = { slug: string; url: (key: string, email: string) => string; parse: (j: any) => Verdict };

/** Сервіси за порядком: перший, для якого є ключ, і перевіряє. */
export const SERVICES: Service[] = [
  {
    slug: "millionverifier",
    url: (k, e) => `https://api.millionverifier.com/api/v3/?api=${encodeURIComponent(k)}&email=${encodeURIComponent(e)}&timeout=20`,
    parse: (j) => ({ ok: "valid", invalid: "invalid", disposable: "invalid", catch_all: "risky", unknown: "unknown" } as Record<string, Verdict>)[String(j?.result)] ?? "unknown",
  },
  {
    slug: "zerobounce",
    url: (k, e) => `https://api.zerobounce.net/v2/validate?api_key=${encodeURIComponent(k)}&email=${encodeURIComponent(e)}`,
    parse: (j) => ({
      valid: "valid", invalid: "invalid", spamtrap: "invalid", abuse: "invalid", do_not_mail: "invalid", "catch-all": "risky", unknown: "unknown",
    } as Record<string, Verdict>)[String(j?.status)] ?? "unknown",
  },
  {
    slug: "hunter",
    url: (k, e) => `https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(e)}&api_key=${encodeURIComponent(k)}`,
    parse: (j) => ({ deliverable: "valid", undeliverable: "invalid", risky: "risky" } as Record<string, Verdict>)[String(j?.data?.result)] ?? "unknown",
  },
];

/** null — жодного сервісу перевірки не підключено (тоді лишається наша MX-перевірка). */
export async function verifyEmail(db: Db, email: string): Promise<{ verdict: Verdict; service: string } | null> {
  for (const s of SERVICES) {
    try {
      const verdict = await withKey(db, s.slug, async (key) => {
        const res = await fetch(s.url(key.secret, email), { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new ProviderHttpError(res.status, `${s.slug}: HTTP ${res.status}`);
        return s.parse(await res.json());
      }, { purpose: "email-verify", retryTransient: true });
      return { verdict, service: s.slug };
    } catch (e) {
      if (e instanceof NoKeyAvailableError) continue;
      return { verdict: "unknown", service: s.slug };
    }
  }
  return null;
}

/** Перевірка адреси з кешем на 30 днів у контактах автора. */
export async function verifiedVerdict(db: Db, creatorId: number, email: string): Promise<{ verdict: Verdict; service: string } | null> {
  const [c] = await db.select().from(creatorContacts).where(and(eq(creatorContacts.creatorId, creatorId), eq(creatorContacts.email, email)));
  if (c?.verdict && c.verifiedAt && Date.now() - c.verifiedAt.getTime() < VERIFY_FRESH_MS) return { verdict: c.verdict, service: c.verifiedBy ?? "" };
  const r = await verifyEmail(db, email);
  if (r && c) await db.update(creatorContacts).set({ verdict: r.verdict, verifiedBy: r.service, verifiedAt: new Date() }).where(eq(creatorContacts.id, c.id));
  return r;
}

/* ---------- ліміт, розгін, здоров’я скриньки ---------- */

/** Скільки листів на добу дозволено зараз: під час розгону — менше за ваш ліміт. */
export function effectiveLimit(mb: Pick<Mailbox, "dailyLimit" | "warmup">, firstSentAt: Date | null, now = new Date()): number {
  if (!mb.warmup) return mb.dailyLimit;
  const days = firstSentAt ? Math.floor((now.getTime() - firstSentAt.getTime()) / DAY) : 0;
  return Math.min(mb.dailyLimit, WARMUP_START + WARMUP_STEP * days);
}

export type MailboxHealth = { sent24h: number; limit: number; sent7d: number; bounced7d: number; bounceRate: number | null; failed7d: number };

export async function mailboxHealth(db: Db, mb: Mailbox, now = new Date()): Promise<MailboxHealth> {
  const [r] = await db.select({
    first: sql<string | null>`min(${outreachMessages.sentAt}) filter (where ${outreachMessages.status} = 'sent')`,
    sent24h: sql<number>`count(*) filter (where ${outreachMessages.status} = 'sent' and ${outreachMessages.sentAt} >= ${new Date(now.getTime() - DAY).toISOString()})::int`,
    sent7d: sql<number>`count(*) filter (where ${outreachMessages.status} = 'sent' and ${outreachMessages.sentAt} >= ${new Date(now.getTime() - 7 * DAY).toISOString()})::int`,
    bounced7d: sql<number>`count(*) filter (where ${outreachMessages.direction} = 'in' and (${outreachMessages.ai}->>'bounce') = 'true' and ${outreachMessages.createdAt} >= ${new Date(now.getTime() - 7 * DAY).toISOString()})::int`,
    failed7d: sql<number>`count(*) filter (where ${outreachMessages.status} = 'failed' and ${outreachMessages.createdAt} >= ${new Date(now.getTime() - 7 * DAY).toISOString()})::int`,
  }).from(outreachMessages).where(eq(outreachMessages.mailboxId, mb.id));
  const first = r?.first ? new Date(r.first) : null;
  const sent7d = r?.sent7d ?? 0;
  const bounced7d = r?.bounced7d ?? 0;
  return {
    sent24h: r?.sent24h ?? 0, limit: effectiveLimit(mb, first, now), sent7d, bounced7d,
    bounceRate: sent7d ? bounced7d / sent7d : null, failed7d: r?.failed7d ?? 0,
  };
}

/** Чи пора зупинити скриньку: частка недоставлених понад 5% (від 10 листів) або 3+ помилки надсилання за тиждень. */
export function pauseReason(h: MailboxHealth): string | null {
  if (h.sent7d >= BOUNCE_MIN_SENT && h.bounceRate != null && h.bounceRate > BOUNCE_LIMIT) {
    return `недоставлених листів ${Math.round(h.bounceRate * 100)}% за тиждень (${h.bounced7d} з ${h.sent7d}) — понад 5%: подальші листи шкодять репутації скриньки`;
  }
  if (h.failed7d >= 3) return `${h.failed7d} помилки надсилання за тиждень — перевірте пароль і налаштування скриньки`;
  return null;
}

/** Перевіряє скриньку й зупиняє її, якщо потрібно. Повертає причину зупинки. */
export async function guardMailbox(db: Db, mb: Mailbox): Promise<string | null> {
  if (mb.pausedAt) return mb.pausedReason ?? "зупинено";
  const reason = pauseReason(await mailboxHealth(db, mb));
  if (reason) await db.update(mailboxes).set({ pausedAt: new Date(), pausedReason: reason }).where(eq(mailboxes.id, mb.id));
  return reason;
}

/** Скринька для нового листування: з тих, що не зупинені, — з найбільшим вільним лімітом на сьогодні. */
export async function pickMailbox(db: Db, ids: number[]): Promise<number | null> {
  const unique = [...new Set(ids)];
  if (!unique.length) return null;
  const boxes = await db.select().from(mailboxes).where(inArray(mailboxes.id, unique));
  // Листи в черзі теж займають ліміт.
  const queued = await db.select({ mailboxId: outreachMessages.mailboxId, n: sql<number>`count(*)::int` }).from(outreachMessages)
    .where(and(eq(outreachMessages.status, "queued"), gte(outreachMessages.createdAt, new Date(Date.now() - DAY)))).groupBy(outreachMessages.mailboxId);
  let best: { id: number; free: number } | null = null;
  for (const id of unique) {
    const mb = boxes.find((b) => b.id === id);
    if (!mb || mb.pausedAt) continue;
    const h = await mailboxHealth(db, mb);
    const free = h.limit - h.sent24h - (queued.find((q) => q.mailboxId === id)?.n ?? 0);
    if (!best || free > best.free) best = { id, free };
  }
  return best?.id ?? null;
}

/* ---------- SPF, DKIM, DMARC ---------- */

const FREEMAIL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com", "ukr.net", "zoho.com", "proton.me", "protonmail.com"]);
const DKIM_SELECTORS = ["google", "selector1", "selector2", "default", "k1", "k2", "zoho", "zmail", "mail", "dkim", "s1", "s2", "smtp", "mxvault"];

type TxtResolver = (name: string) => Promise<string[][]>;

async function txt(resolve: TxtResolver, name: string): Promise<string[]> {
  try {
    return (await resolve(name)).map((parts) => parts.join(""));
  } catch {
    return [];
  }
}

export async function checkDomain(email: string, resolve: TxtResolver = resolveTxt): Promise<DomainCheck> {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  const checkedAt = new Date().toISOString();
  if (FREEMAIL.has(domain)) {
    return {
      checkedAt, domain, freemail: true, spf: "налаштовує провайдер", dmarc: "налаштовує провайдер", dkimSelector: "налаштовує провайдер",
      warnings: ["Безкоштовна скринька (gmail.com тощо): для холодних листів краще окремий домен — так ризик блокування не зачепить вашу основну пошту, а ліміти вищі"],
    };
  }
  const warnings: string[] = [];
  // Сам домен має відповідати: ENODATA — записів TXT немає (це нормально), інше — DNS недоступний.
  let root: string[];
  try {
    root = (await resolve(domain)).map((parts) => parts.join(""));
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code !== "ENODATA") {
      return { checkedAt, domain, freemail: false, spf: null, dmarc: null, dkimSelector: null, warnings: [`Не вдалося перевірити DNS домену (${code ?? "помилка"}) — натисніть «Перевірити» пізніше`] };
    }
    root = [];
  }
  const spf = root.find((r) => /^v=spf1/i.test(r)) ?? null;
  if (!spf) warnings.push("Немає SPF-запису: поштовики не знають, що цей сервер має право надсилати від вашого домену");
  else if (/[+?]all\b/.test(spf)) warnings.push("SPF закінчується на +all чи ?all — він нічого не захищає, потрібно ~all або -all");
  const dmarc = (await txt(resolve, `_dmarc.${domain}`)).find((r) => /^v=DMARC1/i.test(r)) ?? null;
  if (!dmarc) warnings.push("Немає DMARC-запису (_dmarc): Gmail і Yahoo вимагають його для масових відправників");
  let dkimSelector: string | null = null;
  for (const sel of DKIM_SELECTORS) {
    if ((await txt(resolve, `${sel}._domainkey.${domain}`)).some((r) => /v=DKIM1|k=rsa|p=/i.test(r))) {
      dkimSelector = sel;
      break;
    }
  }
  if (!dkimSelector) warnings.push("DKIM не знайдено серед поширених селекторів — увімкніть підпис DKIM у налаштуваннях пошти (або він має нестандартну назву)");
  return { checkedAt, domain, freemail: false, spf, dmarc, dkimSelector, warnings };
}
