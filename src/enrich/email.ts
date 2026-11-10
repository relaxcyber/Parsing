import { resolveMx } from "node:dns/promises";

/**
 * Перевірка email без відправки листів: синтаксис → MX-запис → одноразові та рольові адреси.
 * SMTP-перевірку (RCPT TO) свідомо не робимо: з домашньої мережі порт 25 зазвичай закритий,
 * а зондування поштових серверів веде в чорні списки. Тому найвищий статус тут — «схоже на
 * особисту адресу з робочим доменом», а не «підтверджено доставку».
 */
export type EmailStatus = "personal" | "business" | "role" | "disposable" | "no_mx" | "invalid" | "unknown";
export type EmailCheck = { email: string; status: EmailStatus; confidence: number; mx: string | null };

const SYNTAX = /^[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9_])?@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "icloud.com", "me.com",
  "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.de", "web.de", "mail.com", "ukr.net", "i.ua", "yandex.ru", "mail.ru", "msn.com",
]);
const DISPOSABLE = new Set([
  "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com", "temp-mail.org", "yopmail.com", "trashmail.com", "sharklasers.com",
  "getnada.com", "dispostable.com", "maildrop.cc", "throwawaymail.com", "fakeinbox.com", "mintemail.com", "tempr.email", "emailondeck.com",
]);
const ROLE = /^(info|admin|support|sales|contact|hello|office|team|help|marketing|press|pr|media|booking|bookings|enquiries|inquiries|noreply|no-reply|webmaster|billing|jobs|careers)$/;

type MxResolver = (domain: string) => Promise<{ exchange: string; priority: number }[]>;

export async function checkEmail(raw: string, resolve: MxResolver = resolveMx): Promise<EmailCheck> {
  const email = raw.trim().toLowerCase();
  if (!SYNTAX.test(email) || email.includes("..")) return { email, status: "invalid", confidence: 0, mx: null };
  const [local, domain] = email.split("@");
  if (DISPOSABLE.has(domain)) return { email, status: "disposable", confidence: 0.05, mx: null };

  let mx: string | null = null;
  if (FREEMAIL.has(domain)) mx = "freemail";
  else {
    try {
      const records = (await resolve(domain)).filter((r) => r.exchange && r.exchange !== ".").sort((a, b) => a.priority - b.priority);
      if (records.length === 0) return { email, status: "no_mx", confidence: 0, mx: null };
      mx = records[0].exchange;
    } catch (e: any) {
      // Домену немає або в нього немає пошти — лист гарантовано повернеться.
      if (["ENOTFOUND", "ENODATA", "NXDOMAIN"].includes(e?.code)) return { email, status: "no_mx", confidence: 0, mx: null };
      return { email, status: "unknown", confidence: 0.4, mx: null }; // DNS тимчасово недоступний
    }
  }
  if (ROLE.test(local.replace(/[._-]?\d*$/, ""))) return { email, status: "role", confidence: 0.5, mx };
  return FREEMAIL.has(domain) ? { email, status: "personal", confidence: 0.75, mx } : { email, status: "business", confidence: 0.7, mx };
}

/** Адреси, на які має сенс писати. */
export const usable = (c: EmailCheck) => c.status === "personal" || c.status === "business" || c.status === "role" || c.status === "unknown";
