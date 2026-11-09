import type { Db } from "@/db/client";
import { providers } from "@/db/schema";

type Preset = { slug: string; name: string; kind: "scraper" | "llm"; baseUrl?: string; model?: string };

/**
 * Вбудовані провайдери. Модель LLM — лише стартове значення: безкоштовні
 * моделі часто змінюються, тому її можна поправити в дашборді.
 */
export const PRESETS: Preset[] = [
  { slug: "apify", name: "Apify", kind: "scraper" },
  { slug: "firecrawl", name: "Firecrawl", kind: "scraper" },
  { slug: "reddit", name: "Reddit API", kind: "scraper" },
  { slug: "openrouter", name: "OpenRouter", kind: "llm", baseUrl: "https://openrouter.ai/api/v1" },
  { slug: "gemini", name: "Google Gemini", kind: "llm", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { slug: "groq", name: "Groq", kind: "llm", baseUrl: "https://api.groq.com/openai/v1" },
  { slug: "mistral", name: "Mistral", kind: "llm", baseUrl: "https://api.mistral.ai/v1" },
];

/** Формат секрету, який підказуємо у формі. */
export const SECRET_HINTS: Record<string, string> = {
  reddit: "client_id:client_secret",
};

export async function seedProviders(db: Db) {
  await db
    .insert(providers)
    .values(PRESETS.map((p) => ({ ...p, builtin: true })))
    .onConflictDoNothing({ target: providers.slug });
}
