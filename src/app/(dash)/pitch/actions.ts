"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db/client";
import { jobPitches, type JobPitch } from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import { LlmUnavailableError } from "@/llm/client";
import { checkProposal, createPitch, proposalFacts, rewritePitch } from "@/pitch";

const go = (path: string, msg: string) => redirect(`${path}?msg=${encodeURIComponent(msg)}`);
const str = (form: FormData, k: string, max = 2000) => String(form.get(k) ?? "").trim().slice(0, max);
const idOf = (form: FormData) => z.coerce.number().int().positive().parse(form.get("id"));
const errText = (e: unknown) =>
  e instanceof LlmUnavailableError ? "Мовна модель зараз недоступна — спробуйте пізніше" : `Не вдалося: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`;

async function load(id: number): Promise<JobPitch> {
  const [p] = await getDb().select().from(jobPitches).where(eq(jobPitches.id, id));
  if (!p) go("/pitch", "Відгук не знайдено");
  return p!;
}

export async function createPitchAction(form: FormData) {
  await requireAuth();
  const jobText = str(form, "jobText", 8000);
  const profile = { name: str(form, "name", 60), about: str(form, "about", 600), offer: str(form, "offer", 600) };
  if (jobText.length < 80) go("/pitch", "Вставте повний текст замовлення (хоча б кілька речень)");
  if (!profile.name || !profile.offer) go("/pitch", "Вкажіть ваше ім’я і що саме пропонуєте");
  const platform = z.enum(["auto", "instagram", "tiktok"]).catch("auto").parse(form.get("platform"));
  let id: number;
  let notes: string[];
  try {
    ({ id, notes } = await createPitch(getDb(), { jobText, profile, platform, search: form.get("search") === "on" }));
  } catch (e) {
    return go("/pitch", errText(e));
  }
  redirect(`/pitch/${id}${notes.length ? `?msg=${encodeURIComponent(notes.join("; "))}` : ""}`);
}

export async function rewriteAction(form: FormData) {
  await requireAuth();
  const p = await load(idOf(form));
  // Форма з галочками — вибрані автори; кнопка «без авторів» — порожній список.
  const ids = form.get("pick") ? form.getAll("sample").map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  let msg: string;
  try {
    const r = await rewritePitch(getDb(), p, ids);
    msg = `Відгук переписано${r.samples ? ` з ${r.samples} авторами` : ""}${r.issues.length ? `. Перевірка знайшла: ${r.issues.join("; ")}` : ", перевірку пройдено"}`;
  } catch (e) {
    msg = errText(e);
  }
  go(`/pitch/${p.id}`, msg);
}

/** Ваші правки тексту: перевіряємо так само, як текст моделі. */
export async function saveProposalAction(form: FormData) {
  await requireAuth();
  const p = await load(idOf(form));
  const proposal = str(form, "proposal", 5000);
  const issues = p.analysis ? checkProposal(proposal, proposalFacts(p.analysis, p.profile, p.samples), p.jobText) : [];
  await getDb().update(jobPitches).set({ proposal, issues, updatedAt: new Date() }).where(eq(jobPitches.id, p.id));
  go(`/pitch/${p.id}`, issues.length ? `Збережено. Зверніть увагу: ${issues.join("; ")}` : "Збережено");
}

export async function pitchStatusAction(form: FormData) {
  await requireAuth();
  const id = idOf(form);
  const status = z.enum(["draft", "sent", "replied", "won", "lost"]).parse(form.get("status"));
  await getDb().update(jobPitches).set({ status, updatedAt: new Date() }).where(eq(jobPitches.id, id));
  redirect(str(form, "back") === "list" ? "/pitch" : `/pitch/${id}`);
}

export async function deletePitchAction(form: FormData) {
  await requireAuth();
  await getDb().delete(jobPitches).where(eq(jobPitches.id, idOf(form)));
  go("/pitch", "Відгук видалено (пошук авторів лишився в «Пошуку креаторів»)");
}
