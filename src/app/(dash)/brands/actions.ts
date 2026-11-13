"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createScout, ITEM_USD, pitchBrand, queuePitches, requestVerify, setAccountVerdict, setBrandVerdict, VERIFY_BATCH } from "@/brands";
import { getDb } from "@/db/client";
import { brandScouts, type BrandCreator, type BrandScout } from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import { LlmUnavailableError } from "@/llm/client";

const go = (path: string, msg: string) => redirect(`${path}?msg=${encodeURIComponent(msg)}`);
const str = (form: FormData, k: string, max = 2000) => String(form.get(k) ?? "").trim().slice(0, max);
const idOf = (form: FormData) => z.coerce.number().int().positive().parse(form.get("id"));
const errText = (e: unknown) =>
  e instanceof LlmUnavailableError ? "Мовна модель зараз недоступна, спробуйте пізніше" : `Не вдалося: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`;

async function load(id: number): Promise<BrandScout> {
  const [s] = await getDb().select().from(brandScouts).where(eq(brandScouts.id, id));
  if (!s) go("/brands", "Пошук брендів не знайдено");
  return s!;
}

function creatorOf(form: FormData): BrandCreator | null {
  const c: BrandCreator = {
    name: str(form, "c_name", 60), handle: str(form, "c_handle", 60).replace(/^@/, ""), niche: str(form, "c_niche", 120), followers: str(form, "c_followers", 30),
    about: str(form, "c_about", 600), portfolio: str(form, "c_portfolio", 300), offer: str(form, "c_offer", 600), style: str(form, "c_style", 4000) || undefined,
  };
  if (c.portfolio && !/^https?:\/\//i.test(c.portfolio)) c.portfolio = `https://${c.portfolio}`;
  return c.name || c.about || c.offer ? c : null;
}

const SIZES = { small: { postsPerTag: 30, maxCreators: 40, maxBrands: 30 }, normal: { postsPerTag: 40, maxCreators: 60, maxBrands: 40 }, big: { postsPerTag: 60, maxCreators: 100, maxBrands: 60 } } as const;

export async function createScoutAction(form: FormData) {
  await requireAuth();
  const niche = str(form, "niche", 200);
  if (niche.length < 3) go("/brands", "Опишіть нішу кількома словами, напр. «dog care» чи «skincare for men»");
  const size = SIZES[z.enum(["small", "normal", "big"]).catch("normal").parse(form.get("size"))];
  const hashtags = str(form, "hashtags", 400).split(/[\s,]+/).filter(Boolean);
  const id = await createScout(getDb(), { niche, hashtags, ...size, creator: creatorOf(form) });
  go(`/brands/${id}`, "У черзі: збір іде у фоні кілька хвилин, сторінка оновлюється сама");
}

export async function creatorAction(form: FormData) {
  await requireAuth();
  const s = await load(idOf(form));
  await getDb().update(brandScouts).set({ creator: creatorOf(form), updatedAt: new Date() }).where(eq(brandScouts.id, s.id));
  go(`/brands/${s.id}`, "Дані креатора збережено");
}

export async function pitchAction(form: FormData) {
  await requireAuth();
  const s = await load(idOf(form));
  const handle = str(form, "handle", 60);
  let msg: string;
  try {
    const p = await pitchBrand(getDb(), s, handle);
    msg = p.issues.length ? `Лист для @${handle} написано, але перевірка знайшла: ${p.issues.join("; ")}` : `Лист для @${handle} написано, перевірку пройдено`;
  } catch (e) {
    msg = errText(e);
  }
  go(`/brands/${s.id}`, msg);
}

export async function queuePitchesAction(form: FormData) {
  await requireAuth();
  const s = await load(idOf(form));
  if (!s.creator) go(`/brands/${s.id}`, "Спершу заповніть дані креатора: з них пишуться листи");
  const n = await queuePitches(getDb(), s);
  go(`/brands/${s.id}`, n ? `У черзі ${n} листів: ІІ пише по одному у фоні (з безкоштовним ключем близько хвилини на лист)` : "Немає брендів з email без листа");
}

export async function brandVerdictAction(form: FormData) {
  await requireAuth();
  const s = await load(idOf(form));
  const verdict = z.enum(["brand", "not_brand"]).parse(form.get("verdict"));
  await setBrandVerdict(getDb(), s.id, str(form, "handle", 60), verdict);
  go(`/brands/${s.id}`, "Збережено");
}

export async function rerunScoutAction(form: FormData) {
  await requireAuth();
  const s = await load(idOf(form));
  await getDb().update(brandScouts).set({ status: "queued", error: null, stage: null, updatedAt: new Date() }).where(eq(brandScouts.id, s.id));
  go(`/brands/${s.id}`, "Запущено знову: уже зібрані за останні 6 годин дописи не оплачуються вдруге");
}

const baseUrl = (form: FormData, msg?: string) => {
  const q = new URLSearchParams(str(form, "query", 400));
  if (msg) q.set("msg", msg);
  const qs = q.toString();
  return `/brands/base${qs ? `?${qs}` : ""}`;
};

export async function requestVerifyAction(form: FormData) {
  await requireAuth();
  const ids = form.getAll("ids").map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 200);
  const n = await requestVerify(getDb(), ids);
  redirect(baseUrl(form, n
    ? `У черзі на перевірку ${n} профілів (${n * ITEM_USD < 0.01 ? "менше $0.01" : `≈ $${(n * ITEM_USD).toFixed(2)}`} Apify): фоновий виконавець бере по ${VERIFY_BATCH} за раз`
    : "Немає неперевірених брендів у цьому списку"));
}

export async function accountVerdictAction(form: FormData) {
  await requireAuth();
  const verdict = z.enum(["brand", "not_brand"]).parse(form.get("verdict"));
  await setAccountVerdict(getDb(), str(form, "handle", 60), verdict);
  redirect(baseUrl(form));
}

export async function deleteScoutAction(form: FormData) {
  await requireAuth();
  await getDb().delete(brandScouts).where(eq(brandScouts.id, idOf(form)));
  go("/brands", "Видалено");
}
