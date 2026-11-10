/** Класифікація посилань із профілю та сторінок link-in-bio. */

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
};

/** Сторінки-візитки: з них варто витягати контакти. */
export const LINK_HUB = /(^|\.)(beacons\.ai|beacons\.page|stan\.store|linktr\.ee|carrd\.co|bio\.site|bio\.link|taplink\.cc|msha\.ke|hoo\.be|komi\.io|lnk\.bio|campsite\.bio|linkin\.bio|allmylinks\.com|solo\.to)$/;
const PORTFOLIO = /(^|\.)(canva\.com|canva\.site|my\.canva\.site|drive\.google\.com|docs\.google\.com|notion\.site|notion\.so|behance\.net|dropbox\.com|wixsite\.com|squarespace\.com|journoportfolio\.com|contra\.com|framer\.website|webflow\.io)$/;

/** Партнерські вітрини та скорочувачі партнерських посилань. */
const AFFILIATE: { name: string; test: (url: string, h: string) => boolean }[] = [
  { name: "Amazon Storefront", test: (u, h) => /amazon\.[a-z.]+$/.test(h) && /\/shop\//.test(u) },
  { name: "Amazon", test: (_u, h) => h === "amzn.to" || h === "a.co" },
  { name: "LTK", test: (_u, h) => /(^|\.)(shopltk\.com|liketk\.it|ltk\.app\.link|rstyle\.me)$/.test(h) },
  { name: "ShopMy", test: (_u, h) => /(^|\.)(shopmy\.us|go\.shopmy\.us)$/.test(h) },
  { name: "TikTok Shop", test: (u, h) => /tiktok\.com$/.test(h) && /\/(shop|view\/product)/.test(u) },
  { name: "Mavely", test: (_u, h) => /(^|\.)(mavely\.app\.link|mave\.ly|joinmavely\.com)$/.test(h) },
  { name: "Howl", test: (_u, h) => /(^|\.)(howl\.me|howl\.link)$/.test(h) },
  { name: "Collective Voice", test: (_u, h) => /(^|\.)(shopstyle\.it|go\.shopyourlikes\.com)$/.test(h) },
  { name: "Walmart Creator", test: (u, h) => /walmart\.com$/.test(h) && /\/creator\//.test(u) },
  { name: "Target Partners", test: (u, h) => /target\.com$/.test(h) && /\/creators?\//.test(u) },
];

export type LinkSummary = { hubs: string[]; portfolio: string[]; affiliate: string[]; socials: Record<string, string> };

const SOCIAL: [string, RegExp][] = [
  ["instagram", /instagram\.com\/([A-Za-z0-9._]+)/],
  ["tiktok", /tiktok\.com\/@([A-Za-z0-9._]+)/],
  ["youtube", /youtube\.com\/(@[A-Za-z0-9._-]+|c\/[^/?#]+|channel\/[^/?#]+)/],
];

export function classifyLinks(urls: string[]): LinkSummary {
  const out: LinkSummary = { hubs: [], portfolio: [], affiliate: [], socials: {} };
  for (const url of new Set(urls)) {
    const h = host(url);
    if (!h) continue;
    if (LINK_HUB.test(h)) out.hubs.push(url);
    if (PORTFOLIO.test(h) || /portfolio|media-?kit/i.test(url)) out.portfolio.push(url);
    const aff = AFFILIATE.find((a) => a.test(url, h));
    if (aff && !out.affiliate.includes(aff.name)) out.affiliate.push(aff.name);
    for (const [name, re] of SOCIAL) {
      const m = url.match(re);
      if (m && !out.socials[name] && !/^(p|reel|explore|shop|view)$/.test(m[1])) out.socials[name] = m[1];
    }
  }
  return out;
}
