import { ProviderHttpError } from "@/keys/router";

/** POST JSON із ключем; не-2xx перетворює на ProviderHttpError, щоб роутер міг змінити ключ. */
export async function postJson(url: string, secret: string, body: unknown, timeoutMs: number): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const retry = Number(res.headers.get("retry-after"));
    const text = (await res.text().catch(() => "")).slice(0, 300);
    throw new ProviderHttpError(res.status, `HTTP ${res.status}: ${text}`, Number.isFinite(retry) && retry > 0 ? retry : undefined);
  }
  return res.json();
}
