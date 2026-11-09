"use server";

import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db/client";
import { apiKeys, providers } from "@/db/schema";
import { encryptSecret, secretTail } from "@/keys/crypto";
import { canSync, syncKeyQuota } from "@/keys/quota-sync";
import { requireAuth } from "@/lib/auth";

const back = (msg: string): never => redirect(`/keys?msg=${encodeURIComponent(msg)}`);
const id = (form: FormData) => z.coerce.number().int().positive().parse(form.get("id"));

const KeyForm = z.object({
  providerId: z.coerce.number().int().positive(),
  label: z.string().trim().min(1).max(80),
  secret: z.string().trim().min(4),
  quotaLimit: z.preprocess((v) => (v === "" || v == null ? null : v), z.coerce.number().positive().nullable()),
  quotaUnit: z.enum(["requests", "credits", "tokens", "usd"]),
  quotaPeriod: z.enum(["minute", "day", "month", "none"]),
});

export async function addKey(form: FormData) {
  await requireAuth();
  const parsed = KeyForm.safeParse(Object.fromEntries(form));
  if (!parsed.success) return back("Перевірте поля форми: назва, ключ і ліміт (число більше нуля або порожньо)");
  const { secret, ...rest } = parsed.data;
  const db = getDb();
  const [provider] = await db.select().from(providers).where(eq(providers.id, rest.providerId));
  if (!provider) return back("Провайдера не знайдено");
  const [row] = await db
    .insert(apiKeys)
    .values({ ...rest, secretEnc: encryptSecret(secret), secretTail: secretTail(secret) })
    .returning({ id: apiKeys.id });
  if (canSync(provider.slug)) {
    const r = await syncKeyQuota(db, row.id);
    return back(r.ok ? "Ключ додано, залишок отримано від провайдера" : `Ключ додано, але перевірка не вдалася. ${r.message}`);
  }
  back("Ключ додано");
}

export async function toggleKey(form: FormData) {
  await requireAuth();
  const db = getDb();
  const [key] = await db.select().from(apiKeys).where(eq(apiKeys.id, id(form)));
  if (!key) return back("Ключ не знайдено");
  // «Увімкнути» також знімає паузу та позначку «недійсний».
  const status = key.status === "active" ? "disabled" : "active";
  await db.update(apiKeys).set({ status, cooldownUntil: null, lastError: null }).where(eq(apiKeys.id, key.id));
  back(status === "active" ? "Ключ увімкнено" : "Ключ вимкнено");
}

export async function deleteKey(form: FormData) {
  await requireAuth();
  await getDb().delete(apiKeys).where(eq(apiKeys.id, id(form)));
  back("Ключ видалено");
}

export async function syncKey(form: FormData) {
  await requireAuth();
  const r = await syncKeyQuota(getDb(), id(form));
  back(r.message);
}

const ProviderForm = z.object({
  name: z.string().trim().min(2).max(60),
  baseUrl: z.url({ protocol: /^https?$/ }),
  model: z.string().trim().max(120).optional(),
});

export async function addProvider(form: FormData) {
  await requireAuth();
  const parsed = ProviderForm.safeParse(Object.fromEntries(form));
  if (!parsed.success) return back("Вкажіть назву та коректну базову адресу API (https://…)");
  const { name, baseUrl, model } = parsed.data;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `llm-${Date.now()}`;
  const inserted = await getDb()
    .insert(providers)
    .values({ slug, name, kind: "llm", baseUrl: baseUrl.replace(/\/+$/, ""), model: model || null })
    .onConflictDoNothing({ target: providers.slug })
    .returning({ id: providers.id });
  back(inserted.length ? `Провайдера «${name}» додано` : "Провайдер із такою назвою вже є");
}

export async function setProviderModel(form: FormData) {
  await requireAuth();
  const model = String(form.get("model") ?? "").trim().slice(0, 120);
  await getDb().update(providers).set({ model: model || null }).where(eq(providers.id, id(form)));
  back("Модель збережено");
}

export async function deleteProvider(form: FormData) {
  await requireAuth();
  const gone = await getDb()
    .delete(providers)
    .where(and(eq(providers.id, id(form)), eq(providers.builtin, false)))
    .returning({ id: providers.id });
  back(gone.length ? "Провайдера та його ключі видалено" : "Вбудованого провайдера видалити не можна");
}
