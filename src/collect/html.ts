import { fetchLocalHtml, isChallenge, LocalMiss } from "./local";
import { assertPublicUrl } from "./net";
import { fetchScraplingHtml, ScraplingMissing } from "./scrapling";

/**
 * HTML сторінки лише безкоштовними способами: прямий запит → Scrapling → Scrapling із браузером.
 * Платний Firecrawl тут не використовується: сторінок-візиток сотні, а кредитів мало.
 */
export async function getPageHtml(url: string): Promise<{ html: string; via: string } | { error: string }> {
  await assertPublicUrl(url);
  const tiers: [string, () => Promise<string>][] = [
    ["local", async () => (await fetchLocalHtml(url)).html],
    ["scrapling", () => fetchScraplingHtml(url, "http")],
    ["scrapling-stealth", () => fetchScraplingHtml(url, "stealth")],
  ];
  const misses: string[] = [];
  for (const [via, run] of tiers) {
    try {
      const html = await run();
      if (isChallenge(html)) throw new LocalMiss("захист від ботів");
      return { html, via };
    } catch (e) {
      if (!(e instanceof LocalMiss)) throw e;
      if (e.definitive) return { error: e.message };
      if (!(e instanceof ScraplingMissing)) misses.push(e.message);
    }
  }
  return { error: misses.join("; ") || "недоступно" };
}
