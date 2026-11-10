import { ProviderHttpError } from "@/keys/router";

async function request(url: string, secret: string, init: RequestInit, timeoutMs: number): Promise<any> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${secret}`, ...init.headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const retry = Number(res.headers.get("retry-after"));
    const text = (await res.text().catch(() => "")).slice(0, 300);
    throw new ProviderHttpError(res.status, `HTTP ${res.status}: ${text}`, Number.isFinite(retry) && retry > 0 ? retry : undefined);
  }
  return res.json();
}

/** Запити з ключем; не-2xx стає ProviderHttpError, щоб роутер міг змінити ключ. */
export const postJson = (url: string, secret: string, body: unknown, timeoutMs: number) =>
  request(url, secret, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, timeoutMs);

export const getJson = (url: string, secret: string, timeoutMs: number) => request(url, secret, {}, timeoutMs);
