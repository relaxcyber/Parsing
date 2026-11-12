"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db/client";
import type { ThreadStatus } from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import { LlmUnavailableError } from "@/llm/client";
import {
  allowFee, answerQuestions, approveMessage, checkPost, discardMessage, manualReply, markPosted, markShipped, reprocess,
  resolveHuman, setThreadStatus, startThread, startThreadsForSearch,
} from "@/outreach/engine";

const idOf = (form: FormData, k = "id") => z.coerce.number().int().positive().parse(form.get(k));
const go = (path: string, msg: string) => redirect(`${path}?msg=${encodeURIComponent(msg)}`);
const errText = (e: unknown) =>
  e instanceof LlmUnavailableError ? `Мовна модель зараз недоступна (${e.message}). Спробуйте за хвилину.` : e instanceof Error ? e.message : String(e);

/** Виконує дію над листуванням і повертає на його сторінку з повідомленням. */
async function onThread(form: FormData, fn: (threadId: number) => Promise<string>) {
  await requireAuth();
  const threadId = idOf(form, "threadId");
  let msg: string;
  try {
    msg = await fn(threadId);
  } catch (e) {
    msg = errText(e);
  }
  go(`/inbox/${threadId}`, msg);
}

export async function startThreadAction(form: FormData) {
  await requireAuth();
  const creatorId = idOf(form, "creatorId");
  const r = await startThread(getDb(), {
    creatorId, clientId: idOf(form, "clientId"),
    searchId: z.coerce.number().int().positive().nullable().catch(null).parse(form.get("searchId") || null),
    toEmail: String(form.get("toEmail") ?? "") || null,
  });
  if (!r.id) go(`/creators/${creatorId}`, r.error ?? "Не вдалося почати листування");
  go(`/inbox/${r.id}`, r.created ? "Листування створено: перший лист з’явиться за хвилину" : "Листування з цим автором для клієнта вже є");
}

export async function startForSearch(form: FormData) {
  await requireAuth();
  const searchId = idOf(form, "searchId");
  const r = await startThreadsForSearch(getDb(), searchId);
  go(`/search/${searchId}`, r.error ?? `Листування почато з ${r.created} лідами${r.skipped ? ` (пропущено ${r.skipped}: уже є, відмова, немає email чи у виключеннях)` : ""}. Перші листи — у «Листуванні».`);
}

export async function approve(form: FormData) {
  await onThread(form, async () => {
    await approveMessage(getDb(), idOf(form), { subject: String(form.get("subject") ?? ""), body: String(form.get("body") ?? "") });
    return "Лист поставлено в чергу: піде протягом кількох хвилин (з паузами між листами й денним лімітом скриньки)";
  });
}

export async function discard(form: FormData) {
  await onThread(form, async () => {
    await discardMessage(getDb(), idOf(form));
    return "Чернетку відхилено";
  });
}

export async function answer(form: FormData) {
  await onThread(form, async (threadId) => {
    const qa = form.getAll("q").map((q, i) => ({ q: String(q), a: String(form.getAll("a")[i] ?? "") }));
    if (!qa.some((x) => x.a.trim())) return "Напишіть відповідь хоча б на одне питання";
    const d = await answerQuestions(getDb(), threadId, qa);
    return d?.action === "escalate" ? `Відповіді збережено в правилах, але потрібна ще ваша увага: ${d.reason}` : "Відповіді збережено в правилах клієнта — ІІ підготував лист автору";
  });
}

export async function allowFeeAction(form: FormData) {
  await onThread(form, async (threadId) => {
    const fee = z.coerce.number().positive().parse(String(form.get("fee") ?? "").replace(",", "."));
    await allowFee(getDb(), threadId, fee);
    return `Ставку $${fee} дозволено — ІІ підготував підтвердження`;
  });
}

export async function reprocessAction(form: FormData) {
  await onThread(form, async (threadId) => {
    const d = await reprocess(getDb(), threadId);
    return d ? `Відповідь розібрано наново: ${d.action === "escalate" ? d.reason : d.action === "reply" ? d.why : d.action === "close" ? d.why : d.why}` : "Перший лист буде написано наново";
  });
}

export async function manualReplyAction(form: FormData) {
  await onThread(form, async (threadId) => {
    await manualReply(getDb(), threadId, String(form.get("body") ?? ""));
    return "Ваш лист поставлено в чергу";
  });
}

export async function shippedAction(form: FormData) {
  await onThread(form, async (threadId) => {
    await markShipped(getDb(), threadId);
    return "Позначено: товар відправлено. Публікацію перевірятимемо автоматично";
  });
}

export async function postedAction(form: FormData) {
  await onThread(form, async (threadId) => {
    const url = String(form.get("url") ?? "").trim();
    if (!/^https?:\/\//.test(url)) return "Вставте посилання на допис";
    await markPosted(getDb(), threadId, url);
    return "Допис зараховано";
  });
}

export async function checkPostAction(form: FormData) {
  await onThread(form, async (threadId) => {
    const c = await checkPost(getDb(), threadId);
    return c.found ? `Допис знайдено${c.disclosure ? "" : ", але без позначки реклами"}` : `Допису ще немає: ${c.note ?? ""}`;
  });
}

export async function statusAction(form: FormData) {
  await onThread(form, async (threadId) => {
    const status = z.enum(["declined", "closed", "no_reply", "agreed", "to_ship"]).parse(form.get("status")) as ThreadStatus;
    await setThreadStatus(getDb(), threadId, status);
    return "Статус змінено";
  });
}

export async function resolveAction(form: FormData) {
  await onThread(form, async (threadId) => {
    await resolveHuman(getDb(), threadId);
    return "Позначку знято";
  });
}
