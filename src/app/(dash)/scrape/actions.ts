"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db/client";
import { scrapeJobs } from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import { parseFields } from "@/scrape/extract";
import { parseUrls } from "@/scrape/jobs";

const back = (msg: string): never => redirect(`/scrape?msg=${encodeURIComponent(msg)}`);
const id = (form: FormData) => z.coerce.number().int().positive().parse(form.get("id"));

export async function createJob(form: FormData) {
  await requireAuth();
  const name = String(form.get("name") ?? "").trim().slice(0, 80);
  const urls = parseUrls(String(form.get("urls") ?? ""));
  const mode = z.enum(["auto", "selectors", "ai"]).catch("auto").parse(form.get("mode"));
  const fields = parseFields(String(form.get("fields") ?? ""));
  if (name.length < 2) return back("Вкажіть назву завдання");
  if (urls.length === 0) return back("Не знайдено жодної адреси: кожна має починатися з https://");
  if (mode === "selectors" && !fields.some((f) => f.selector)) return back("Для режиму селекторів опишіть поля у вигляді «назва = селектор»");
  if (mode === "ai" && fields.length === 0) return back("Для режиму з моделлю перелічіть назви полів через кому");
  const [row] = await getDb().insert(scrapeJobs)
    .values({ name, urls, mode, fields, allowPaid: form.get("allowPaid") === "on", total: urls.length })
    .returning({ id: scrapeJobs.id });
  redirect(`/scrape/${row.id}`);
}

export async function cancelJob(form: FormData) {
  await requireAuth();
  await getDb().update(scrapeJobs).set({ status: "cancelled", finishedAt: new Date() }).where(eq(scrapeJobs.id, id(form)));
  redirect(`/scrape/${id(form)}`);
}

/** Повторний запуск добирає лише сторінки, яких ще немає або які минулого разу не вдалися. */
export async function rerunJob(form: FormData) {
  await requireAuth();
  await getDb().update(scrapeJobs).set({ status: "queued", error: null, finishedAt: null }).where(eq(scrapeJobs.id, id(form)));
  redirect(`/scrape/${id(form)}`);
}

export async function deleteJob(form: FormData) {
  await requireAuth();
  await getDb().delete(scrapeJobs).where(eq(scrapeJobs.id, id(form)));
  back("Завдання видалено");
}
