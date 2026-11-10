"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db/client";
import { searches } from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import { creators } from "@/db/schema";
import { normalizeCountry } from "@/enrich/geo";
import { suppressCreator } from "@/search/suppress";

const list = (max: number) =>
  z.string().transform((v) => [...new Set(v.split(/[,\n]/).map((s) => s.trim().replace(/^#/, "").toLowerCase()).filter(Boolean))].slice(0, max));
const optionalInt = z.preprocess((v) => (v === "" || v == null ? null : v), z.coerce.number().int().nonnegative().nullable());

const SearchForm = z.object({
  name: z.string().trim().min(2).max(80),
  hashtags: list(10).refine((a) => a.length > 0),
  keywords: list(20),
  stopWords: list(30),
  postsPerTag: z.coerce.number().int().min(5).max(200),
  maxProfiles: z.coerce.number().int().min(1).max(300),
  minFollowers: optionalInt,
  maxFollowers: optionalInt,
  outreachLanguage: z.enum(["en", "uk", "ru", "pl", "de", "es"]),
  focus: z.enum(["ugc", "affiliate"]),
  countries: z.string().default("").transform((v) => [...new Set(v.split(/[,\s]+/).map((c) => normalizeCountry(c)).filter((c) => /^[A-Z]{2}$/.test(c)))].slice(0, 20)),
  languages: z.string().default("").transform((v) => [...new Set(v.split(/[,\s]+/).map((c) => c.trim().toLowerCase()).filter((c) => /^[a-z]{2}$/.test(c)))].slice(0, 10)),
  auditLimit: z.coerce.number().int().min(0).max(150),
});

export async function createSearch(form: FormData) {
  await requireAuth();
  const parsed = SearchForm.safeParse(Object.fromEntries(form));
  if (!parsed.success) {
    redirect(`/search?msg=${encodeURIComponent("Перевірте форму: потрібні назва і хоча б один хештег; дописів на хештег — 5–200, профілів — до 300")}`);
  }
  const [row] = await getDb().insert(searches).values(parsed.data).returning({ id: searches.id });
  redirect(`/search/${row.id}`);
}

const id = (form: FormData) => z.coerce.number().int().positive().parse(form.get("id"));

export async function cancelSearch(form: FormData) {
  await requireAuth();
  const searchId = id(form);
  await getDb().update(searches).set({ status: "cancelled", finishedAt: new Date() })
    .where(eq(searches.id, searchId));
  redirect(`/search/${searchId}`);
}

export async function rerunSearch(form: FormData) {
  await requireAuth();
  const searchId = id(form);
  const db = getDb();
  const [s] = await db.select().from(searches).where(eq(searches.id, searchId));
  if (s && s.status !== "running" && s.status !== "queued") {
    await db.update(searches).set({ status: "queued", error: null, progress: null, finishedAt: null }).where(eq(searches.id, searchId));
  }
  redirect(`/search/${searchId}`);
}

export async function deleteSearch(form: FormData) {
  await requireAuth();
  await getDb().delete(searches).where(eq(searches.id, id(form)));
  redirect(`/search?msg=${encodeURIComponent("Пошук видалено")}`);
}

/** Видалити автора й більше ніколи його не збирати (запит на видалення даних). */
export async function suppress(form: FormData) {
  await requireAuth();
  const searchId = z.coerce.number().int().positive().parse(form.get("searchId"));
  await suppressCreator(getDb(), id(form), "видалено вручну з дашборда");
  redirect(`/search/${searchId}?view=${encodeURIComponent(String(form.get("view") ?? "qualified"))}`);
}

/** Ваш вердикт щодо автора: еталон, за яким калібруються пороги моделі. Повторний клік знімає позначку. */
export async function setVerdict(form: FormData) {
  await requireAuth();
  const searchId = z.coerce.number().int().positive().parse(form.get("searchId"));
  const verdict = z.enum(["yes", "no"]).parse(form.get("verdict"));
  const db = getDb();
  const [c] = await db.select({ v: creators.manualVerdict }).from(creators).where(eq(creators.id, id(form)));
  if (c) await db.update(creators).set({ manualVerdict: c.v === verdict ? null : verdict }).where(eq(creators.id, id(form)));
  redirect(`/search/${searchId}?view=${encodeURIComponent(String(form.get("view") ?? "qualified"))}`);
}
