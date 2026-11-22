#!/usr/bin/env node
// Captures the reference set that grades T11 (e-mountain bike listings on a marketplace, within 20 km of a zip code):
// every listing the marketplace's own searches return, read through the daemon, page by page.
//   node listings-reference.mjs <daemon MCP URL> <out file>
// Run it just before and just after the batch: grade.mjs takes the union of every reference-*.json in the out dir,
// since listings come and go and auction prices move during a batch.
//
// A listing is an e-mountain bike within 20 km when one of the bike searches returns it. The plain text search is
// captured too, so that a listing only it returns (a stand, a display, a shop's clearance sale) is marked as not a
// bike rather than unknown.
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const AREA = "range=20&zip_code=8810";
const SEARCHES = {
  bike_type: `https://www.ricardo.ch/de/c/velos-82249/?${AREA}&attribute_groups.bike_type=6546`,
  bikes_e_mountainbike: `https://www.ricardo.ch/de/c/velos-82249/e-mountainbike/?${AREA}`,
  bikes_e_mtb: `https://www.ricardo.ch/de/c/velos-82249/e-mtb/?${AREA}`,
  plain_search: `https://www.ricardo.ch/de/s/e-mountainbike/?${AREA}`,
};
const BIKE_SEARCHES = ["bike_type", "bikes_e_mountainbike", "bikes_e_mtb"];
const PER_PAGE = 60;
const MAX_PAGES = 10;

const [url, outFile] = process.argv.slice(2);
if (!url || !outFile) {
  console.error("usage: node listings-reference.mjs <daemon MCP URL> <out file>");
  process.exit(2);
}

const client = new Client({ name: "spike-reference", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));
async function call(name, args) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 400_000 });
  const text = r.content.map((c) => c.text ?? "").join("\n");
  if (r.isError) throw new Error(`${name}: ${text.slice(0, 300)}`);
  return text;
}

// Each result card: the listing's id, its image's alt text (the title), its first lines (title, brand) and its prices.
// The console's reply holds at most 12,000 characters, so the cards are read in slices.
const SLICE = 20;
const readCards = (from) => `
  const cards = await page.locator('a[href*="/de/a/"]').evaluateAll(as => as.map(a => {
    const lines = a.innerText.split('\\n').map(s => s.trim()).filter(Boolean);
    return { id: (a.href.match(/-(\\d{8,})\\/?$/) || [])[1], alt: a.querySelector('img')?.alt ?? null,
      lines: lines.filter(l => !/^\\d[\\d']*\\.\\d{2}$/.test(l)).slice(0, 3), prices: lines.filter(l => /^\\d[\\d']*\\.\\d{2}$/.test(l)) };
  }));
  const seen = new Set();
  const unique = cards.filter(c => c.id && !seen.has(c.id) && seen.add(c.id));
  const count = await page.getByText(/^\\d+ Resultate$/).first().innerText().catch(() => null);
  return { count, total: unique.length, cards: unique.slice(${from}, ${from} + ${SLICE}) };`;

async function cardsOnPage() {
  const all = [];
  let count = null;
  for (let from = 0; ; from += SLICE) {
    const reply = JSON.parse(await call("browser_eval", { browser, code: readCards(from) }));
    if (reply.truncated) throw new Error(`a slice of ${SLICE} cards is over the console's limit`);
    count ??= reply.value.count;
    all.push(...reply.value.cards);
    if (from + SLICE >= reply.value.total) return { count, cards: all };
  }
}

const browser = JSON.parse(await call("start", {})).browser;
const listings = {};
const searches = {};
try {
  for (const [name, base] of Object.entries(SEARCHES)) {
    let pages = 1;
    for (let p = 1; p <= pages; p++) {
      await call("browse", { browser, action: "open", url: p === 1 ? base : `${base}&page=${p}` });
      const value = await cardsOnPage();
      if (p === 1) {
        const count = Number(String(value.count ?? "").match(/\d+/)?.[0] ?? 0);
        searches[name] = { url: base, count };
        pages = Math.min(MAX_PAGES, Math.ceil(count / PER_PAGE));
      }
      for (const card of value.cards) {
        const l = (listings[card.id] ??= { alt: card.alt, lines: card.lines, prices: card.prices, searches: [] });
        if (!l.searches.includes(name)) l.searches.push(name);
      }
    }
  }
} finally {
  await call("close", { browser });
  await client.close();
}
writeFileSync(outFile, JSON.stringify({ captured_at: new Date().toISOString(), bike_searches: BIKE_SEARCHES, searches, listings }, null, 1));
const bikes = Object.values(listings).filter((l) => l.searches.some((s) => BIKE_SEARCHES.includes(s))).length;
console.log(`${Object.keys(listings).length} listings, ${bikes} of them from a bike search; ${JSON.stringify(searches)}`);
