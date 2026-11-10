import { lookup } from "node:dns/promises";
import net from "node:net";

/** Адреса веде не в публічний інтернет — запит з ноутбука туди не робимо. */
export class UnsafeUrlError extends Error {}

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
] as const) blocked.addSubnet(addr, prefix, "ipv4");
for (const [addr, prefix] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96]] as const) {
  blocked.addSubnet(addr, prefix, "ipv6");
}

export function isPrivateAddress(ip: string): boolean {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return blocked.check(mapped[1], "ipv4");
  return net.isIPv4(ip) ? blocked.check(ip, "ipv4") : net.isIPv6(ip) ? blocked.check(ip, "ipv6") : true;
}

type Resolver = (host: string) => Promise<string[]>;
const dns: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

/**
 * Дозволяє лише http(s) без логіна в адресі та лише публічні IP.
 * ALLOW_PRIVATE_URLS=1 вимикає перевірку (для збору з власної локальної мережі).
 */
export async function assertPublicUrl(raw: string, resolve: Resolver = dns): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("Некоректна адреса");
  }
  if (!/^https?:$/.test(url.protocol)) throw new UnsafeUrlError("Підтримуються лише адреси http(s)");
  if (url.username || url.password) throw new UnsafeUrlError("Адреси з логіном і паролем не підтримуються");
  if (process.env.ALLOW_PRIVATE_URLS === "1") return url;

  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (net.isIP(host)) addresses = [host];
  else if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) addresses = ["127.0.0.1"];
  else {
    try {
      addresses = await resolve(host);
    } catch {
      return url; // ім’я не резолвиться — запит і так не відбудеться
    }
  }
  if (addresses.some(isPrivateAddress)) throw new UnsafeUrlError(`Адреса ${host} веде у внутрішню мережу — такі запити заборонені`);
  return url;
}

const TRACKING = /^(utm_\w+|fbclid|gclid|yclid|mc_cid|mc_eid|igshid|ref_src)$/i;

/** Канонічний вигляд адреси для кешу та дедуплікації: без фрагмента й рекламних міток. */
export function normalizeUrl(raw: string): string {
  const u = new URL(raw);
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  for (const key of [...u.searchParams.keys()]) if (TRACKING.test(key)) u.searchParams.delete(key);
  u.searchParams.sort();
  return u.toString();
}
