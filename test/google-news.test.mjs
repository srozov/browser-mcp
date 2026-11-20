import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { BATCHEXECUTE, CONSENT, RSS_ARTICLE, RSS_SEARCH, articleId, batchBody, googleNews, parseBatch } from "../src/google-news.mjs";

// Google News' RSS search for "Example Widgets AG" (recorded 2026-11-19, names invented), cut to three items: 17 Nov (WSJ), 16 Nov (Reuters), 12 Nov (NPR).
const RSS = readFileSync(resolve(import.meta.dirname, "./fixtures/news/google-news-search.xml"), "utf8");
const ids = [...RSS.matchAll(/<link>https:\/\/news\.google\.com\/rss\/articles\/([^?<]+)/g)].map((m) => m[1]);
const WSJ = "https://www.wsj.com/tech/example-widgets-regulator-probe-sample-departure";
// A batchexecute answer in the shape googlenewsdecoder's parser reads: an anti-JSON prefix, then one wrb.fr envelope per
// id with its request id last. Built by hand, as the decoding answers 2026-11-19 were not recorded.
const batch = (pairs) => `)]}'\n\n${JSON.stringify([...pairs.map(([id, url]) => ["wrb.fr", "Fbv4je",
  JSON.stringify(["garturlres", url, 1]), null, null, null, id]), ["di", 42]])}`;

function google({ consent = [], fail = false } = {}) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, init });
    const headers = new Headers();
    if (url.startsWith(RSS_SEARCH)) return { ok: !fail, status: fail ? 503 : 200, headers, text: async () => RSS };
    if (url.startsWith(RSS_ARTICLE)) {
      const id = new URL(url).pathname.split("/").at(-1);
      if (consent.includes(id)) {
        headers.set("location", `https://consent.google.com/m?continue=${encodeURIComponent(url)}`);
        return { ok: false, status: 302, headers, text: async () => "" };
      }
      return { ok: true, status: 200, headers,
        text: async () => `<c-wiz><div jscontroller="x" data-n-a-sg="sig-${id.slice(-4)}" data-n-a-ts="1763400000"></div></c-wiz>` };
    }
    if (url === BATCHEXECUTE) return { ok: true, status: 200, headers, text: async () => batch([["0", WSJ]]) };
    throw new Error(`unexpected ${url}`);
  };
  return { fetchFn, calls };
}

test("lists the window's headlines with outlet and time, decodes a link and keeps one that does not decode", async () => {
  const { fetchFn, calls } = google({ consent: [ids[1]] });
  const out = await googleNews(fetchFn, { query: "Example Widgets AG", edition: "US", from: "2026-11-13", to: "2026-11-18" });
  assert.deepEqual(out.items.map((i) => [i.outlet, i.published.slice(0, 10)]), [["WSJ", "2026-11-17"], ["Reuters", "2026-11-16"]]);   // 12 Nov is outside
  assert.equal(out.items[0].title, "Exclusive | Regulator Is Probing Example Widgets AG Amid Departure of Alex Sample");   // the " - WSJ" suffix goes
  assert.equal(out.items[0].site, "https://www.wsj.com");
  assert.equal(out.items[0].url, WSJ);
  assert.equal(out.items[1].url, null);
  assert.match(out.items[1].google_url, /^https:\/\/news\.google\.com\/rss\/articles\//);
  assert.equal(out.decoded, "1 of 2");
  assert.match(out.note, /1 links did not decode \(Google sent the article page to consent\.google\.com\)/);
  const search = new URL(calls[0].url).searchParams;
  assert.deepEqual([search.get("q"), search.get("hl"), search.get("gl"), search.get("ceid")],
    ["Example Widgets AG after:2026-11-13 before:2026-11-19", "en-US", "US", "US:en"]);
  const article = calls.find((c) => c.url.startsWith(RSS_ARTICLE));
  assert.equal(article.init.redirect, "manual");   // a redirect off news.google.com is read, never followed
  // Every request answers Google's cookie-consent page "Reject all", as a browser does once asked.
  assert.ok(calls.every((c) => c.init.headers?.cookie === "SOCS=CAI") && CONSENT.cookie === "SOCS=CAI");
  const post = calls.find((c) => c.url === BATCHEXECUTE);
  const [[envelope]] = JSON.parse(decodeURIComponent(post.init.body.replace(/^f\.req=/, "")));
  assert.deepEqual(JSON.parse(envelope[1]).slice(2), [ids[0], 1763400000, `sig-${ids[0].slice(-4)}`]);
  assert.equal(envelope[3], "0");
});

test("no link decodes should Google send every article page to its consent page, and the search still answers", async () => {
  const { fetchFn, calls } = google({ consent: ids });
  const out = await googleNews(fetchFn, { query: "Example Widgets AG", edition: "CH", from: "2026-11-13", to: "2026-11-18" });
  assert.equal(out.decoded, "0 of 2");
  assert.ok(out.items.every((i) => i.url === null && i.google_url));
  assert.ok(!calls.some((c) => c.url === BATCHEXECUTE));
  assert.equal(new URL(calls[0].url).searchParams.get("ceid"), "CH:de");
});

test("a search that fails is an error; an unknown edition is refused", async () => {
  await assert.rejects(googleNews(google({ fail: true }).fetchFn, { query: "Example Widgets AG", edition: "US", from: "2026-11-13", to: "2026-11-18" }), /HTTP 503/);
  await assert.rejects(googleNews(google().fetchFn, { query: "Example Widgets AG", edition: "XX", from: "2026-11-13", to: "2026-11-18" }), /no edition XX/);
});

test("the decoding's pieces: an article id, the request body and the answer by request id", () => {
  assert.equal(articleId(`https://news.google.com/rss/articles/${ids[0]}?oc=5`), ids[0]);
  assert.equal(articleId("https://www.wsj.com/x"), null);
  const body = batchBody([{ index: 3, id: "CBMiX", timestamp: "17", signature: "s" }]);
  assert.match(decodeURIComponent(body), /^f\.req=\[\[\["Fbv4je","\[\\"garturlreq\\",/);
  assert.deepEqual([...parseBatch(batch([["3", "https://a.test/x"], ["5", "https://b.test/y"]]))],
    [["3", "https://a.test/x"], ["5", "https://b.test/y"]]);
});
