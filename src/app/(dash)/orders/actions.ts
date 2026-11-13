"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db/client";
import { orders } from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import { LlmUnavailableError } from "@/llm/client";
import {
  addClientMessage, createClientForOrder, createOrder, createOrderFromPitch, draftDelivery, markSent, restartOrderSearch, reviewNow, setNotes, startOrderSearch,
} from "@/orders";
import { setReviewVerdict } from "@/orders/review";
import { lastProfile } from "@/pitch";

const str = (form: FormData, k: string, max = 8000) => String(form.get(k) ?? "").trim().slice(0, max);
const idOf = (form: FormData, k = "id") => z.coerce.number().int().positive().parse(form.get(k));
const go = (path: string, msg?: string | null) => redirect(msg ? `${path}?msg=${encodeURIComponent(msg)}` : path);
const errText = (e: unknown) =>
  e instanceof LlmUnavailableError ? "Мовна модель зараз недоступна — спробуйте пізніше" : `Не вдалося: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`;

/** Дія з моделлю: помилку показуємо на сторінці замовлення, а не падаємо. */
async function run(path: string, fn: () => Promise<string | null>) {
  let msg: string | null;
  try {
    msg = await fn();
  } catch (e) {
    msg = errText(e);
  }
  go(path, msg);
}

export async function createOrderAction(form: FormData) {
  await requireAuth();
  const firstMessage = str(form, "firstMessage");
  if (firstMessage.length < 30) go("/orders", "Вставте повідомлення клієнта чи текст замовлення");
  const prev = await lastProfile(getDb());
  const profile = { name: str(form, "name", 60) || prev?.name || "", about: str(form, "about", 600) || prev?.about || "", offer: str(form, "offer", 600) || prev?.offer || "", style: prev?.style };
  if (!profile.name) go("/orders", "Вкажіть ваше ім’я для підпису");
  let id = 0;
  try {
    id = (await createOrder(getDb(), { firstMessage, profile })).id;
  } catch (e) {
    go("/orders", errText(e));
  }
  go(`/orders/${id}`);
}

export async function fromPitchAction(form: FormData) {
  await requireAuth();
  let id = 0;
  try {
    id = (await createOrderFromPitch(getDb(), idOf(form, "pitchId"))).id;
  } catch (e) {
    go(`/pitch/${idOf(form, "pitchId")}`, errText(e));
  }
  go(`/orders/${id}`, "Замовлення створено з відгуку. Вставте відповідь клієнта — ІІ розбере її");
}

export async function clientMessageAction(form: FormData) {
  await requireAuth();
  const id = idOf(form);
  const text = str(form, "text");
  if (text.length < 2) go(`/orders/${id}`, "Вставте повідомлення клієнта");
  await run(`/orders/${id}`, async () => {
    const o = await addClientMessage(getDb(), id, text);
    return o.status === "needs_you" ? "Клієнт питає те, чого ІІ не знає, — напишіть підказку нижче" : o.draft ? "Відповідь готова — перевірте й надішліть" : "Розібрано, відповідь не потрібна";
  });
}

export async function notesAction(form: FormData) {
  await requireAuth();
  const id = idOf(form);
  await run(`/orders/${id}`, async () => {
    const o = await setNotes(getDb(), id, str(form, "notes", 2000));
    return o.status === "needs_you" ? "Ще лишились питання без відповіді" : "Відповідь переписано з вашими підказками";
  });
}

export async function sentAction(form: FormData) {
  await requireAuth();
  const id = idOf(form);
  await run(`/orders/${id}`, async () => {
    const manual = !!form.get("manual");
    const r = await markSent(getDb(), id, str(form, "text") || undefined, { manual });
    if (manual) return "Записано в переписку";
    if (r.started.length) return `Записано. Пошук запущено (${r.started.length}) — результат з’явиться тут${r.note ? `; ${r.note}` : ""}`;
    return r.note ? `Записано. ${r.note}` : "Записано в переписку";
  });
}

export async function startSearchAction(form: FormData) {
  await requireAuth();
  const id = idOf(form);
  await run(`/orders/${id}`, async () => {
    const r = form.get("restart") ? await restartOrderSearch(getDb(), id) : await startOrderSearch(getDb(), id);
    return r.ids.length ? `Пошук запущено${r.note ? `; ${r.note}` : ""}` : r.note ?? "Пошук не запущено";
  });
}

export async function deliveryAction(form: FormData) {
  await requireAuth();
  const id = idOf(form);
  await run(`/orders/${id}`, async () => {
    const o = await draftDelivery(getDb(), id);
    return o.draftIssues.length ? `Чернетка готова, але перевірка знайшла: ${o.draftIssues.join("; ")}` : "Повідомлення з результатом готове — прикладіть CSV і надішліть";
  });
}

export async function outreachClientAction(form: FormData) {
  await requireAuth();
  const id = idOf(form);
  const clientId = await createClientForOrder(getDb(), id);
  go(`/clients/${clientId}`, "Клієнта створено з даних замовлення — допишіть правила оплати й підключіть скриньку");
}

export async function orderStatusAction(form: FormData) {
  await requireAuth();
  const id = idOf(form);
  const status = z.enum(["closed", "delivered"]).parse(form.get("status"));
  await getDb().update(orders).set({ status, updatedAt: new Date() }).where(eq(orders.id, id));
  go(`/orders/${id}`);
}

export async function deleteOrderAction(form: FormData) {
  await requireAuth();
  await getDb().delete(orders).where(eq(orders.id, idOf(form)));
  go("/orders", "Замовлення видалено (пошуки лишились у «Пошуку креаторів»)");
}

export async function reviewNowAction(form: FormData) {
  await requireAuth();
  const id = idOf(form);
  await run(`/orders/${id}`, async () => {
    const r = await reviewNow(getDb(), id);
    if (r.order.status === "searching") return "Підходящих не вистачило — запущено добір авторів";
    return r.finished ? "Список перевірено, повідомлення з результатом готове" : "Перевірено частину — решту ІІ дочитає у фоні";
  });
}

export async function verdictAction(form: FormData) {
  await requireAuth();
  const id = idOf(form);
  await setReviewVerdict(getDb(), id, idOf(form, "creatorId"), z.enum(["fits", "no"]).parse(form.get("verdict")));
  go(`/orders/${id}`);
}
