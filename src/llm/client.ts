import { asc, eq } from "drizzle-orm";
import type { z } from "zod";
import type { Db } from "@/db/client";
import { providers } from "@/db/schema";
import { NoKeyAvailableError, ProviderHttpError, withKey } from "@/keys/router";

export type ChatPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string | ChatPart[] };

/** Усі мовні моделі зараз зайняті або вичерпані; retryAt — коли найближчий ключ звільниться. */
export class LlmUnavailableError extends Error {
  constructor(message: string, public retryAt: Date | null) {
    super(message);
  }
}

const PREFERRED = ["groq", "gemini", "openrouter", "mistral"];

async function callProvider(db: Db, p: { slug: string; baseUrl: string; model: string }, messages: ChatMessage[], purpose: string, maxTokens: number): Promise<string> {
  return withKey(
    db,
    p.slug,
    async (key) => {
      const res = await fetch(`${p.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key.secret}`, "content-type": "application/json" },
        body: JSON.stringify({ model: p.model, messages, temperature: 0.2, max_tokens: maxTokens, response_format: { type: "json_object" } }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) {
        const retry = Number(res.headers.get("retry-after"));
        const text = (await res.text().catch(() => "")).slice(0, 300);
        throw new ProviderHttpError(res.status, `${p.slug}: HTTP ${res.status}: ${text}`, Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : undefined);
      }
      const body = await res.json();
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) throw new Error(`${p.slug}: порожня відповідь моделі`);
      return content;
    },
    { purpose, retryTransient: true },
  );
}

/** Дістає JSON із відповіді, навіть якщо модель обгорнула його текстом чи ```-блоком. */
export function parseJsonReply(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("у відповіді моделі немає JSON");
  return JSON.parse(fenced.slice(start, end + 1));
}

/**
 * Запит до мовної моделі з відповіддю у JSON, перевіреною схемою.
 * Провайдери перебираються по черзі (спершу Groq); у кожного — своя ротація ключів.
 */
export async function chatJson<T>(db: Db, schema: z.ZodType<T>, messages: ChatMessage[], opts: { purpose: string; maxTokens?: number }): Promise<T> {
  const all = await db.select().from(providers).where(eq(providers.kind, "llm")).orderBy(asc(providers.id));
  const ready = all
    .filter((p): p is typeof p & { baseUrl: string; model: string } => !!p.baseUrl && !!p.model)
    .sort((a, b) => (PREFERRED.indexOf(a.slug) + 100) % 100 - (PREFERRED.indexOf(b.slug) + 100) % 100);
  if (ready.length === 0) throw new LlmUnavailableError("Не задано модель у жодного провайдера мовних моделей (сторінка «Ключі та ліміти»)", null);

  let retryAt: Date | null = null;
  let lastError: unknown;
  for (const p of ready) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const reply = await callProvider(db, p, messages, opts.purpose, opts.maxTokens ?? 700);
        return schema.parse(parseJsonReply(reply));
      } catch (e) {
        lastError = e;
        if (e instanceof NoKeyAvailableError) {
          if (e.retryAt && (!retryAt || e.retryAt < retryAt)) retryAt = e.retryAt;
          break; // у цього провайдера ключів немає — наступний
        }
        if (e instanceof ProviderHttpError) break;
        // Невалідний JSON або схема — одна повторна спроба, далі інший провайдер.
      }
    }
  }
  if (lastError instanceof NoKeyAvailableError || lastError instanceof ProviderHttpError) {
    throw new LlmUnavailableError(`Мовні моделі недоступні: ${(lastError as Error).message}`, retryAt);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
