"use server";

import { redirect } from "next/navigation";
import { collect, type Target } from "@/collect";
import { cleanHandle } from "@/collect/instagram";
import { getDb } from "@/db/client";
import { requireAuth } from "@/lib/auth";

const back = (msg: string): never => redirect(`/collect?msg=${encodeURIComponent(msg)}`);

export async function runCollect(form: FormData) {
  await requireAuth();
  const mode = String(form.get("mode"));
  const value = String(form.get("value") ?? "").trim();
  const limit = Number(form.get("limit")) || 20;
  if (!value) return back("Вкажіть адресу, профіль або хештег");

  let target: Target;
  if (mode === "instagram-profile") target = { type: "instagram-profile", username: cleanHandle(value) };
  else if (mode === "instagram-hashtag") target = { type: "instagram-hashtag", tag: cleanHandle(value), limit };
  else {
    if (!URL.canParse(value)) return back("Це не схоже на адресу сторінки (потрібно https://…)");
    target = { type: "url", url: value };
  }

  let msg: string;
  try {
    const r = await collect(getDb(), target, { fresh: form.get("fresh") === "on" });
    msg = [`Зібрано елементів: ${r.items.length}${r.cached ? " (з кешу, до 24 год)" : ""}`, ...r.notes].join(". ");
  } catch (e) {
    msg = `Не вдалося зібрати: ${e instanceof Error ? e.message : e}`;
  }
  back(msg);
}
