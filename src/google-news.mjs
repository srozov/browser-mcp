// Google News: the dated headlines of the RSS search, with the outlet named, and each link decoded to the outlet's
// page. Moved from the page readers' browser server's news-search module. The search's links are Google redirects:
// they are decoded the way googlenewsdecoder does it (MIT, https://github.com/SSujitX/google-news-url-decoder): the
// article's /rss/articles/ page carries a signature and a timestamp, and one batchexecute POST turns them into the
// outlet's URL. In Europe Google first shows a visitor its cookie-consent page; every request answers it as "Reject
// all" does in a browser, with Google's SOCS cookie (without it no link decoded). A link that does not decode keeps
// url null; the item still carries google_url. Pure over an injected fetch, so it is tested without the network.

export const RSS_SEARCH = "https://news.google.com/rss/search";
export const RSS_ARTICLE = "https://news.google.com/rss/articles/";
export const BATCHEXECUTE = "https://news.google.com/_/DotsSplashUi/data/batchexecute";
const MAX_ITEMS = 50;
const DECODE_CONCURRENCY = 5;
export const CONSENT = { cookie: "SOCS=CAI" };   // Google's cookie-consent page answered "Reject all"

// Each edition's language, country and edition id, as Google News' own edition menu sets them.
export const EDITIONS = {
  CH: ["de", "CH", "CH:de"], US: ["en-US", "US", "US:en"], GB: ["en-GB", "GB", "GB:en"], DE: ["de", "DE", "DE:de"],
  AT: ["de", "AT", "AT:de"], FR: ["fr", "FR", "FR:fr"], HK: ["zh-HK", "HK", "HK:zh-Hant"], CN: ["zh-CN", "CN", "CN:zh-Hans"],
  RU: ["ru", "RU", "RU:ru"],
};

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const unescape = (s) => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, e) => ENTITIES[e]);
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? unescape(m[1].replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1")).trim() : null;
};
const nextDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** The RSS search's items between `from` and `to` (YYYY-MM-DD, UTC days), newest first, at most 50. */
export function parseSearch(xml, { from, to }) {
  const items = [];
  for (const [, entry] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const date = new Date(tag(entry, "pubDate") || "");
    if (Number.isNaN(date.getTime())) continue;
    const published = date.toISOString();
    if (published.slice(0, 10) < from || published.slice(0, 10) > to) continue;   // the search's dates are loose
    const outlet = tag(entry, "source");
    let title = tag(entry, "title") || "";
    if (outlet && title.endsWith(` - ${outlet}`)) title = title.slice(0, -(outlet.length + 3));
    const site = entry.match(/<source\s+url="([^"]+)"/)?.[1] ?? null;   // the outlet's own address
    items.push({ title, outlet, site, published, url: null, google_url: tag(entry, "link") });
  }
  return items.sort((a, b) => b.published.localeCompare(a.published)).slice(0, MAX_ITEMS);
}

/** The article id in a Google News link (`…/rss/articles/<id>?oc=5`), or null. */
export function articleId(link) {
  try {
    const url = new URL(link);
    const path = url.pathname.split("/");
    return url.hostname === "news.google.com" && ["articles", "read"].includes(path.at(-2)) ? path.at(-1) || null : null;
  } catch {
    return null;
  }
}

/** The signature and timestamp an article page carries for the decoding, or null. */
export function parseSignature(html) {
  const sg = html.match(/data-n-a-sg="([^"]+)"/);
  const ts = html.match(/data-n-a-ts="([^"]+)"/);
  return sg && ts ? { signature: sg[1], timestamp: ts[1] } : null;
}

// The request context googlenewsdecoder sends with every id; Google answers with the outlet's URL.
const CONTEXT = [["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1], "X", "X",
  1, [1, 1, 1], 1, 1, null, 0, 0, null, 0];

export function batchBody(pending) {
  const envelopes = pending.map(({ index, id, timestamp, signature }) => ["Fbv4je",
    JSON.stringify(["garturlreq", CONTEXT, id, /^\d+$/.test(timestamp) ? Number(timestamp) : timestamp, signature]), null, String(index)]);
  return `f.req=${encodeURIComponent(JSON.stringify([envelopes]))}`;
}

/** The decoded URLs of a batchexecute answer, by the request id each envelope carried. */
export function parseBatch(text) {
  let body = text.includes("\n\n") ? text.split("\n\n").slice(1).join("\n\n") : text;
  body = body.trimStart();
  if (body.startsWith(")]}'")) body = body.slice(body.indexOf("\n") + 1);
  const urls = new Map();
  for (const row of JSON.parse(body)) {
    if (!Array.isArray(row) || row.length < 3 || row[0] !== "wrb.fr" || typeof row[2] !== "string") continue;
    const payload = JSON.parse(row[2]);
    if (!Array.isArray(payload) || payload[0] !== "garturlres") continue;
    const id = row.slice(3).reverse().find((cell) => cell !== null && cell !== undefined);
    if (id !== undefined) urls.set(String(id), payload[1]);
  }
  return urls;
}

// An article page that redirects stays on news.google.com for at most three hops; anywhere else (Google's consent page,
// should it come back despite the cookie), the link does not decode. Returns the signature or why not.
async function signatureOf(fetchFn, id, edition) {
  const [hl, gl, ceid] = EDITIONS[edition];
  let url = `${RSS_ARTICLE}${id}?${new URLSearchParams({ hl, gl, ceid })}`;
  for (let hop = 0; hop < 3; hop++) {
    const response = await fetchFn(url, { redirect: "manual", headers: CONSENT });
    const location = response.headers?.get?.("location");
    if (response.status >= 300 && response.status < 400 && location) {
      const next = new URL(location, url);
      if (next.hostname !== "news.google.com") return { reason: `Google sent the article page to ${next.hostname}` };
      url = next.href;
      continue;
    }
    if (!response.ok) return { reason: `the article page answered HTTP ${response.status}` };
    return parseSignature(await response.text()) ?? { reason: "the article page carries no signature" };
  }
  return { reason: "the article page redirected more than three times" };
}

// Decodes the items' links in place; returns why links did not decode, or []. Once Google sends one article page
// elsewhere, it sends them all there: the rest are not asked.
async function decode(fetchFn, items, edition) {
  const pending = [];
  const reasons = new Set();
  let next = 0;
  let sentAway = false;
  const worker = async () => {
    while (next < items.length && !sentAway) {
      const index = next++;
      const id = articleId(items[index].google_url);
      const found = id ? await signatureOf(fetchFn, id, edition).catch((e) => ({ reason: String(e.message || e) }))
        : { reason: "a link is not a Google News article" };
      if (found.signature) pending.push({ index, id, ...found });
      else reasons.add(found.reason);
      if (found.reason?.startsWith("Google sent")) sentAway = true;
    }
  };
  await Promise.all(Array.from({ length: DECODE_CONCURRENCY }, worker));
  if (!pending.length) return [...reasons];
  const response = await fetchFn(BATCHEXECUTE, { method: "POST", body: batchBody(pending),
    headers: { ...CONSENT, "content-type": "application/x-www-form-urlencoded;charset=UTF-8" } });
  if (!response.ok) return [...reasons, `the decoding answered HTTP ${response.status}`];
  const urls = parseBatch(await response.text());
  for (const { index } of pending) items[index].url = urls.get(String(index)) ?? null;
  if (pending.some(({ index }) => !items[index].url)) reasons.add("the decoding gave no URL for some links");
  return [...reasons];
}

/** Google News' headlines for `query` in one edition, published between `from` and `to` (YYYY-MM-DD). */
export async function googleNews(fetchFn, { query, edition, from, to }) {
  if (!Object.hasOwn(EDITIONS, edition)) throw new Error(`no edition ${edition}: one of ${Object.keys(EDITIONS).join(", ")}`);
  const [hl, gl, ceid] = EDITIONS[edition];
  const q = `${query} after:${from} before:${nextDay(to)}`;
  const response = await fetchFn(`${RSS_SEARCH}?${new URLSearchParams({ q, hl, gl, ceid })}`, { headers: CONSENT });
  if (!response.ok) throw new Error(`Google News answered HTTP ${response.status}`);
  const items = parseSearch(await response.text(), { from, to });
  const reasons = items.length ? await decode(fetchFn, items, edition).catch((e) => [String(e.message || e)]) : [];
  const decoded = items.filter((i) => i.url).length;
  const out = { query, edition, from, to, decoded: `${decoded} of ${items.length}`, items };
  if (decoded < items.length) {
    out.note = `${items.length - decoded} links did not decode (${reasons.join("; ")}): their url is null, and `
      + "google_url is Google's redirect, which a reader may not open";
  }
  return out;
}
