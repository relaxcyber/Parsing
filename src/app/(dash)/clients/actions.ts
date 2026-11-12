"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db/client";
import { clients, mailboxes, type ClientPolicy } from "@/db/schema";
import { encryptSecret } from "@/keys/crypto";
import { requireAuth } from "@/lib/auth";
import { testMailbox } from "@/outreach/engine";
import { DEFAULT_POLICY, policyOf } from "@/outreach/policy";

const back = (path: string, msg: string) => redirect(`${path}${path.includes("?") ? "&" : "?"}msg=${encodeURIComponent(msg)}`);
const idOf = (form: FormData, k = "id") => z.coerce.number().int().positive().parse(form.get(k));
const str = (form: FormData, k: string, max = 2000) => String(form.get(k) ?? "").trim().slice(0, max);
const money = (form: FormData, k: string) => {
  const v = str(form, k).replace(",", ".").replace(/[$\s]/g, "");
  const n = Number(v);
  return v && Number.isFinite(n) && n >= 0 ? n : null;
};
const list = (form: FormData, k: string) => [...new Set(str(form, k).split(/[,\n]/).map((s) => s.trim()).filter(Boolean))].slice(0, 20);

export async function createClient(form: FormData) {
  await requireAuth();
  const name = str(form, "name", 80);
  if (name.length < 2) back("/clients", "Вкажіть назву клієнта");
  const [mb] = await getDb().select({ id: mailboxes.id }).from(mailboxes).limit(1);
  const [row] = await getDb().insert(clients).values({ name, policy: { ...DEFAULT_POLICY, brandName: name }, mailboxId: mb?.id ?? null }).returning({ id: clients.id });
  redirect(`/clients/${row.id}`);
}

export async function saveClient(form: FormData) {
  await requireAuth();
  const id = idOf(form);
  const db = getDb();
  const [c] = await db.select().from(clients).where(eq(clients.id, id));
  if (!c) back("/clients", "Клієнта не знайдено");
  const old = policyOf(c.policy);
  const offerType = z.enum(["barter", "paid", "both"]).catch("barter").parse(form.get("offerType"));
  const feeTarget = money(form, "feeTargetUsd");
  const feeMax = money(form, "feeMaxUsd");
  const policy: ClientPolicy = {
    ...old,
    brandName: str(form, "brandName", 80),
    website: str(form, "website", 200),
    product: str(form, "product", 600),
    offerType,
    productValueUsd: money(form, "productValueUsd"),
    feeTargetUsd: feeTarget != null && feeMax != null ? Math.min(feeTarget, feeMax) : feeTarget,
    feeMaxUsd: feeMax,
    maxRounds: z.coerce.number().int().min(0).max(5).catch(2).parse(form.get("maxRounds")),
    aboveMax: z.enum(["escalate", "decline"]).catch("escalate").parse(form.get("aboveMax")),
    deliverables: str(form, "deliverables", 400),
    deadlineDays: z.coerce.number().int().min(1).max(120).catch(14).parse(form.get("deadlineDays")),
    usageRights: str(form, "usageRights", 400),
    disclosure: str(form, "disclosure", 300),
    mustTag: list(form, "mustTag").map((t) => (/^[@#]/.test(t) ? t : `@${t}`).toLowerCase()),
    shipsTo: list(form, "shipsTo").map((x) => x.toUpperCase()).filter((x) => /^[A-Z]{2}$/.test(x)),
    notes: str(form, "notes", 3000),
    mode: z.enum(["approve", "auto"]).catch("approve").parse(form.get("mode")),
    followupDays: z.coerce.number().int().min(1).max(30).catch(4).parse(form.get("followupDays")),
    senderName: str(form, "senderName", 80),
  };
  const mailboxId = z.coerce.number().int().positive().nullable().catch(null).parse(form.get("mailboxId") || null);
  await db.update(clients).set({ name: str(form, "name", 80) || c.name, policy, mailboxId }).where(eq(clients.id, id));
  back(`/clients/${id}`, "Правила збережено");
}

export async function deleteFaq(form: FormData) {
  await requireAuth();
  const id = idOf(form);
  const index = z.coerce.number().int().nonnegative().parse(form.get("index"));
  const db = getDb();
  const [c] = await db.select().from(clients).where(eq(clients.id, id));
  if (c) {
    const p = policyOf(c.policy);
    await db.update(clients).set({ policy: { ...p, faq: p.faq.filter((_, i) => i !== index) } }).where(eq(clients.id, id));
  }
  revalidatePath(`/clients/${id}`);
}

export async function deleteClient(form: FormData) {
  await requireAuth();
  await getDb().delete(clients).where(eq(clients.id, idOf(form)));
  back("/clients", "Клієнта видалено разом із його листуванням");
}

/** Готові налаштування поширених поштових сервісів. */
const PRESETS: Record<string, { smtpHost: string; smtpPort: number; imapHost: string; imapPort: number }> = {
  gmail: { smtpHost: "smtp.gmail.com", smtpPort: 465, imapHost: "imap.gmail.com", imapPort: 993 },
  outlook: { smtpHost: "smtp-mail.outlook.com", smtpPort: 587, imapHost: "outlook.office365.com", imapPort: 993 },
  zoho: { smtpHost: "smtp.zoho.eu", smtpPort: 465, imapHost: "imap.zoho.eu", imapPort: 993 },
  ukrnet: { smtpHost: "smtp.ukr.net", smtpPort: 465, imapHost: "imap.ukr.net", imapPort: 993 },
};

export async function addMailbox(form: FormData) {
  await requireAuth();
  const email = str(form, "email", 200).toLowerCase();
  const password = String(form.get("password") ?? "");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !password) back("/clients", "Вкажіть адресу й пароль застосунку");
  const preset = PRESETS[str(form, "preset")] ?? null;
  const port = (k: string, def: number) => z.coerce.number().int().min(1).max(65535).catch(def).parse(form.get(k) || def);
  const values = {
    email, fromName: str(form, "fromName", 80) || null,
    smtpHost: str(form, "smtpHost", 200) || preset?.smtpHost || "",
    smtpPort: str(form, "smtpPort") ? port("smtpPort", 465) : preset?.smtpPort ?? 465,
    imapHost: str(form, "imapHost", 200) || preset?.imapHost || "",
    imapPort: str(form, "imapPort") ? port("imapPort", 993) : preset?.imapPort ?? 993,
    username: str(form, "username", 200) || email,
    passwordEnc: encryptSecret(password),
    dailyLimit: z.coerce.number().int().min(1).max(500).catch(30).parse(form.get("dailyLimit") || 30),
  };
  if (!values.smtpHost || !values.imapHost) back("/clients", "Вкажіть сервери SMTP та IMAP або виберіть поштовий сервіс");
  const db = getDb();
  const [row] = await db.insert(mailboxes).values(values).onConflictDoUpdate({ target: mailboxes.email, set: values }).returning();
  const error = await testMailbox(row);
  await db.update(mailboxes).set({ lastError: error }).where(eq(mailboxes.id, row.id));
  back("/clients", error ? `Скриньку збережено, але підключитися не вдалося: ${error}` : "Скриньку підключено: надсилання й читання працюють");
}

export async function checkMailbox(form: FormData) {
  await requireAuth();
  const db = getDb();
  const [mb] = await db.select().from(mailboxes).where(eq(mailboxes.id, idOf(form)));
  if (!mb) back("/clients", "Скриньку не знайдено");
  const error = await testMailbox(mb);
  await db.update(mailboxes).set({ lastError: error }).where(eq(mailboxes.id, mb.id));
  back("/clients", error ? `Підключитися не вдалося: ${error}` : "Скринька працює");
}

export async function deleteMailbox(form: FormData) {
  await requireAuth();
  await getDb().delete(mailboxes).where(eq(mailboxes.id, idOf(form)));
  back("/clients", "Скриньку видалено");
}
