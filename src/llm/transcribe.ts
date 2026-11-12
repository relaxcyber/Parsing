import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { providers } from "@/db/schema";
import { ProviderHttpError, withKey } from "@/keys/router";

export const WHISPER_MODEL = "whisper-large-v3-turbo";
export type Transcript = { text: string; language: string | null; duration: number | null };

/**
 * Розшифровка мовлення через Groq (Whisper). Дає точну мову автора, показує, чи говорить він у кадрі,
 * і що саме каже в перші секунди. null — немає ключа Groq або звук не розпізнано.
 */
export async function transcribe(db: Db, audio: Buffer): Promise<Transcript | null> {
  const [groq] = await db.select().from(providers).where(eq(providers.slug, "groq"));
  if (!groq?.baseUrl) return null;
  try {
    return await withKey(
      db,
      "groq",
      async (key) => {
        const form = new FormData();
        form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/mpeg" }), "audio.mp3");
        form.append("model", WHISPER_MODEL);
        form.append("response_format", "verbose_json");
        form.append("temperature", "0");
        const res = await fetch(`${groq.baseUrl}/audio/transcriptions`, {
          method: "POST", headers: { Authorization: `Bearer ${key.secret}` }, body: form, signal: AbortSignal.timeout(90_000),
        });
        if (!res.ok) {
          const retry = Number(res.headers.get("retry-after"));
          throw new ProviderHttpError(res.status, `groq whisper: HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`, Number.isFinite(retry) && retry > 0 ? retry : undefined);
        }
        const body: any = await res.json();
        const text = typeof body?.text === "string" ? body.text.trim() : "";
        if (!text) return null;
        const lang = typeof body.language === "string" ? body.language.toLowerCase() : null;
        return { text: text.slice(0, 4000), language: lang ? (LANG_NAMES[lang] ?? (lang.length === 2 ? lang : null)) : null, duration: typeof body.duration === "number" ? body.duration : null };
      },
      { purpose: "transcribe", retryTransient: true },
    );
  } catch {
    return null; // розшифровка — додатковий сигнал, без неї аудит теж працює
  }
}

/** Whisper повертає назву мови англійською. */
const LANG_NAMES: Record<string, string> = {
  english: "en", ukrainian: "uk", russian: "ru", polish: "pl", german: "de", spanish: "es", french: "fr", italian: "it",
  portuguese: "pt", dutch: "nl", turkish: "tr", arabic: "ar", hindi: "hi", indonesian: "id", japanese: "ja", korean: "ko", chinese: "zh",
};
