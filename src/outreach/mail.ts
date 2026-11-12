import { randomBytes } from "node:crypto";
import type { Mailbox } from "@/db/schema";
import { decryptSecret } from "@/keys/crypto";

/**
 * Пошта: SMTP — надсилання, IMAP — читання відповідей з теки «Вхідні».
 * Працює з будь-якою скринькою, що дає SMTP/IMAP (Gmail і Google Workspace — через пароль застосунку,
 * Zoho, Outlook, власний домен). Транспорт можна підмінити — так його перевіряють тести.
 */

export type OutMail = {
  from: string;
  fromName?: string | null;
  to: string;
  subject: string;
  text: string;
  messageId: string;
  inReplyTo?: string | null;
  references?: string[];
};

export type InMail = {
  uid: number;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: string;
  subject: string;
  text: string;
  date: Date;
  /** Автовідповідь («я у відпустці»): заголовки Auto-Submitted, X-Autoreply тощо. */
  auto: boolean;
  /** Повідомлення про недоставку від поштового сервера. */
  bounce: boolean;
};

export type FetchResult = { mails: InMail[]; lastUid: number | null; uidValidity: string | null };

export interface MailTransport {
  verify(): Promise<void>;
  send(mail: OutMail): Promise<void>;
  /** Нові листи після lastUid. Перше читання скриньки лише запам’ятовує позицію: старі листи не обробляються. */
  fetchNew(lastUid: number | null, uidValidity: string | null): Promise<FetchResult>;
}

type Factory = (mb: Mailbox) => MailTransport;
let factory: Factory | null = null;

/** Для тестів: підмінити справжню пошту. */
export function setTransportFactory(f: Factory | null): void {
  factory = f;
}

export function transportFor(mb: Mailbox): MailTransport {
  return factory ? factory(mb) : realTransport(mb);
}

/** Message-ID у домені скриньки: за ним відповідь автора знайде свій ланцюжок. */
export function newMessageId(fromEmail: string): string {
  const domain = fromEmail.split("@")[1] || "localhost";
  return `<${Date.now().toString(36)}.${randomBytes(6).toString("hex")}@${domain}>`;
}

export const normEmail = (s: string) => s.trim().toLowerCase().replace(/^.*<([^>]+)>.*$/, "$1");

/**
 * Відрізає процитовану переписку: модель має читати лише нове, що написав автор,
 * а не наш власний лист, який поштовик додав нижче.
 */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const markers = [
    /^\s*On .{3,200}wrote:\s*$/i,
    /^\s*(Am|El|Le|Il|W dniu) .{3,200}(schrieb|escribió|a écrit|ha scritto|napisał).{0,20}:\s*$/i,
    /^\s*.{3,200}(пише|написав|написала|написал|написала\(а\)|пишет):\s*$/i,
    /^\s*-{2,}\s*(Original Message|Исходное сообщение|Вихідне повідомлення|Forwarded message)/i,
    /^\s*From: .+$/i,
    /^\s*Від: .+$/i,
    /^\s*От: .+$/i,
  ];
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (markers.some((m) => m.test(lines[i]))) {
      end = i;
      break;
    }
  }
  const kept = lines.slice(0, end).filter((l) => !/^\s*>/.test(l));
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function realTransport(mb: Mailbox): MailTransport {
  const password = () => decryptSecret(mb.passwordEnc);
  const smtp = async () => {
    const nodemailer = await import("nodemailer");
    return nodemailer.createTransport({
      host: mb.smtpHost, port: mb.smtpPort, secure: mb.smtpPort === 465,
      auth: { user: mb.username, pass: password() },
      connectionTimeout: 20_000, greetingTimeout: 20_000, socketTimeout: 60_000,
    });
  };
  const imap = async () => {
    const { ImapFlow } = await import("imapflow");
    return new ImapFlow({ host: mb.imapHost, port: mb.imapPort, secure: mb.imapPort === 993, auth: { user: mb.username, pass: password() }, logger: false });
  };

  return {
    async verify() {
      const t = await smtp();
      await t.verify();
      const client = await imap();
      await client.connect();
      await client.logout();
    },

    async send(m) {
      const t = await smtp();
      await t.sendMail({
        from: m.fromName ? { name: m.fromName, address: m.from } : m.from,
        to: m.to, subject: m.subject, text: m.text, messageId: m.messageId,
        inReplyTo: m.inReplyTo ?? undefined, references: m.references?.length ? m.references : undefined,
      });
    },

    async fetchNew(lastUid, uidValidity) {
      const { simpleParser } = await import("mailparser");
      const client = await imap();
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      try {
        const box = client.mailbox;
        const validity = box && typeof box === "object" ? String(box.uidValidity) : null;
        const uidNext = box && typeof box === "object" ? Number(box.uidNext) : 1;
        // Перше читання або скриньку перебудовано (інший UIDVALIDITY): починаємо з поточної позиції.
        if (lastUid == null || validity !== uidValidity) return { mails: [], lastUid: uidNext - 1, uidValidity: validity };
        const mails: InMail[] = [];
        let maxUid = lastUid;
        for await (const msg of client.fetch(`${lastUid + 1}:*`, { uid: true, source: true }, { uid: true })) {
          if (msg.uid <= lastUid || !msg.source) continue; // «n:*» повертає останній лист, навіть якщо він старий
          maxUid = Math.max(maxUid, msg.uid);
          const p = await simpleParser(msg.source);
          const header = (k: string) => String(p.headers.get(k) ?? "");
          const from = p.from?.value?.[0]?.address ?? "";
          const refs = Array.isArray(p.references) ? p.references : p.references ? [p.references] : [];
          const ctype = header("content-type");
          mails.push({
            uid: msg.uid,
            messageId: p.messageId ?? null,
            inReplyTo: p.inReplyTo ?? null,
            references: refs,
            from,
            subject: p.subject ?? "",
            text: p.text ?? "",
            date: p.date ?? new Date(),
            auto: /auto-replied|auto-generated/i.test(header("auto-submitted")) || !!p.headers.get("x-autoreply") || /auto_reply|autoreply/i.test(header("x-auto-response-suppress") + header("precedence")),
            bounce: /mailer-daemon|postmaster/i.test(from) || /multipart\/report/i.test(ctype),
          });
          if (mails.length >= 50) break;
        }
        return { mails, lastUid: maxUid, uidValidity: validity };
      } finally {
        lock.release();
        await client.logout().catch(() => {});
      }
    },
  };
}
