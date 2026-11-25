// End-to-end tests of acquire and the downloads a click starts, over Streamable HTTP MCP, with the local forward proxy
// that plays the internet (test/fixture-site.mjs). Network-free; needs Chrome, Xvfb and poppler. The daemon harness is
// a small copy of test/daemon.test.mjs's.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TEST_HOSTS, startFixtureSite } from "./fixture-site.mjs";

const DAEMON = resolve(import.meta.dirname, "../src/daemon.mjs");
const ISSUER = "http://ir.issuer.test";

let site;
let root;
let d;
let c;
const daemons = [];
const saveDirs = [];

async function freePort() {
  const probe = createServer();
  await new Promise((ok) => probe.listen(0, "127.0.0.1", ok));
  const { port } = probe.address();
  await new Promise((ok) => probe.close(ok));
  return port;
}

/** Spawn a daemon on its own state directory (`env` adds settings); resolves once it listens, with a client. */
async function daemon(name, env = {}) {
  for (const dir of ["base", `${name}-state`, `${name}-named`]) mkdirSync(join(root, dir), { recursive: true });
  const port = await freePort();
  const proc = spawn(process.execPath, [DAEMON], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env,
    BROWSER_PORT: String(port), BROWSER_BASE_PROFILE: join(root, "base"), BROWSER_STATE_DIR: join(root, `${name}-state`),
    BROWSER_PROFILE_ROOT: join(root, `${name}-named`), BROWSER_MINIMAX_KEY: "test-key", BROWSER_TEST_PROXY: site.url,
    BROWSER_TEST_HOSTS: JSON.stringify(TEST_HOSTS), BROWSER_TEST_CALL_LIMIT_MS: "20000", ...env } });
  const one = { proc, stateDir: join(root, `${name}-state`), exited: new Promise((ok) => proc.once("exit", ok)) };
  daemons.push(one);
  await new Promise((ok, err) => {
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
      if (stderr.includes("listening on")) ok();
    });
    one.exited.then((code) => err(new Error(`daemon exited with ${code}: ${stderr}`)));
  });
  one.client = new Client({ name: "test", version: "0" });
  await one.client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return one;
}

before(async () => {
  site = await startFixtureSite();
  root = mkdtempSync(join(tmpdir(), "browser-mcp-acquire-"));
  d = await daemon("main");
  c = d.client;
});

after(async () => {
  for (const one of daemons) {
    await one.client?.close();
    one.proc.kill("SIGTERM");
    await one.exited;
  }
  site?.server.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

async function call(name, args, client = c) {
  const r = await client.callTool({ name, arguments: args });
  return { error: !!r.isError, text: r.content.filter((x) => x.type === "text").map((x) => x.text).join("\n") };
}

const newSaveDir = () => {
  const dir = mkdtempSync(join(root, "save-"));
  saveDirs.push(dir);
  return dir;
};

/** A browser with a fresh save_dir (or none, with `save: false`), closed after fn whatever happens. */
async function withBrowser(fn, { save = true, saveDir = save ? newSaveDir() : undefined } = {}) {
  const r = await call("start", saveDir ? { save_dir: saveDir } : {});
  assert.equal(r.error, false, r.text);
  const b = JSON.parse(r.text).browser;
  try {
    await fn(b, saveDir);
  } finally {
    await call("close", { browser: b });
  }
}

const browse = (b, args) => call("browse", { browser: b, ...args });
const acquire = (b, args) => call("acquire", { browser: b, ...args });
const registry = (dir) => readFileSync(join(dir, "sources", "registry.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const source = (dir, id, ...path) => join(dir, "sources", id, ...path);
const refOf = (listing, text) => /\[ref=(e\d+)\]/.exec(listing.split("\n").find((l) => l.includes("[ref=") && l.includes(text)) ?? "")?.[1];
const leaked = (prefixes) => site.hits.filter((h) => prefixes.some((p) => h.startsWith(p)));
const events = (handle) => readFileSync(join(d.stateDir, "logs", `${handle}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("a linked PDF is saved with its pages, images and provenance; saved again it keeps its source_id", () => withBrowser(async (b, dir) => {
  await browse(b, { action: "open", url: `${ISSUER}/reports` });
  const o = await browse(b, { action: "observe", query: "ar-2025" });
  const r = await acquire(b, { ref: refOf(o.text, "ar-2025") });
  assert.equal(r.error, false, r.text);
  const src = JSON.parse(r.text);
  assert.match(src.source_id, /^s[0-9a-f]{10}$/);
  assert.equal(src.kind, "pdf");
  assert.equal(src.title, "Annual Report 2025");
  assert.equal(src.pages, 6);
  assert.equal(src.final_url, "http://cdn.shared.test/space1/ar-2025.pdf");
  assert.equal(src.parent_url, `${ISSUER}/reports`);
  assert.deepEqual(src.publication_evidence, { http_last_modified: "Tue, 03 Mar 2026 06:30:00 GMT", pdf_created: "2026-03-02T09:00:00Z",
    pdf_modified: "2026-03-02T10:00:00Z", link_context: "2025 Annual Report (published 3 March 2026) Download pdf" });
  assert.equal(src.files.original, source(dir, src.source_id, "original.pdf"));
  assert.equal(readFileSync(src.files.original).subarray(0, 5).toString(), "%PDF-");
  assert.match(readFileSync(source(dir, src.source_id, "pages", "0002.txt"), "utf8"), /Operating profit 210\.5/);
  assert.ok(existsSync(source(dir, src.source_id, "pages", "0002.png")));
  assert.equal(src.files.reading, `${source(dir, src.source_id, "reading", "NNNN.txt")} (the same pages' text in reading order, a column's sentences together)`);
  for (let n = 1; n <= 6; n++) assert.ok(existsSync(source(dir, src.source_id, "reading", `000${n}.txt`)));
  assert.ok(!existsSync(source(dir, src.source_id, "reading", "0007.txt")));
  const [rec] = registry(dir);
  assert.equal(rec.files.reading, `sources/${src.source_id}/reading/NNNN.txt (the same pages' text in reading order, a column's sentences together)`);
  assert.equal(rec.event, "acquired");
  assert.equal(rec.via, "link");
  assert.equal(rec.link_text, "Download pdf");
  assert.equal(rec.requested_url, "http://cdn.shared.test/space1/ar-2025.pdf");
  assert.match(rec.sha256, /^[0-9a-f]{64}$/);
  assert.match(rec.retrieved_at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(rec.browser, undefined, "a shared registry names no caller's browser");
  const again = JSON.parse((await acquire(b, { url: "http://cdn.shared.test/space1/ar-2025.pdf" })).text);
  assert.equal(again.source_id, src.source_id);
  assert.equal(again.note, "already acquired; same bytes and source id");
  assert.equal(again.pages, 6);
  assert.deepEqual(again.files, src.files);
  assert.deepEqual(registry(dir).map((x) => x.event), ["acquired", "acquired_again"]);
  assert.deepEqual(readdirSync(join(dir, "sources")).sort(), [".staging", "registry.jsonl", src.source_id]);
  assert.deepEqual(readdirSync(join(dir, "sources", ".staging")), []);
}));

test("acquire takes a document's URL directly; open of a document says to acquire it and keeps the page", () => withBrowser(async (b, dir) => {
  const r = await acquire(b, { url: "http://cdn.shared.test/space2/other.pdf#page=2" });
  assert.equal(r.error, false, r.text);
  const rec = registry(dir).find((x) => x.source_id === JSON.parse(r.text).source_id);
  assert.equal(rec.via, "url");
  assert.equal(rec.parent_url, null);
  assert.equal(rec.requested_url, "http://cdn.shared.test/space2/other.pdf");
  for (const url of ["http://127.0.0.1:9/x.pdf", "http://inside.test/x.pdf", "file:///etc/passwd"]) {
    const blocked = await acquire(b, { url });
    assert.equal(blocked.error, true, url);
    assert.match(blocked.text, /is blocked \((private_host|resolves_private 10\.9\.9\.9|scheme)\)/, url);
  }
  await browse(b, { action: "open", url: `${ISSUER}/reports` });
  const doc = await browse(b, { action: "open", url: "http://cdn.shared.test/space1/ar-2024.pdf" });
  assert.equal(doc.error, true);
  assert.match(doc.text, /is a document, not a page: save it with acquire \{url\}; the tab is back on http:\/\/ir\.issuer\.test\/reports/);
  assert.match((await browse(b, { action: "text" })).text, /Report archive/);
  assert.match((await acquire(b, {})).text, /acquire needs url, ref or current_page/);
  assert.match((await acquire(b, { url: `${ISSUER}/reports`, current_page: true })).text, /acquire takes one of url, ref or current_page, not url and current_page/);
}));

test("the current page is saved with its HTML, text and image; a ref that is not a link is refused", () => withBrowser(async (b, dir) => {
  await browse(b, { action: "open", url: `${ISSUER}/reports` });
  const r = await acquire(b, { current_page: true });
  assert.equal(r.error, false, r.text);
  const p = JSON.parse(r.text);
  assert.match(p.source_id, /^h[0-9a-f]{10}$/);
  assert.equal(p.kind, "html");
  assert.equal(p.final_url, `${ISSUER}/reports`);
  assert.match(readFileSync(p.files.original, "utf8"), /<h1>Reports<\/h1>/);
  assert.match(readFileSync(p.files.text, "utf8"), /Report archive/);
  assert.equal(readFileSync(p.files.image).subarray(1, 4).toString(), "PNG");
  assert.match(p.hint, /page\.png is the rendered page/);
  const o = await browse(b, { action: "observe" });
  const notLink = await acquire(b, { ref: refOf(o.text, "heading") });
  assert.match(notLink.text, /is a heading, not a link: acquire takes a link's ref/);
  assert.deepEqual(registry(dir).map((x) => x.source_id), [p.source_id]);
}));

test("a page whose image times out, or that is too tall, is saved and registered once, without an image", () => withBrowser(async (b, dir) => {
  const r = await acquire(b, { url: "http://filings.regulator.test/long-20f.htm" });
  assert.equal(r.error, false, r.text);
  const p = JSON.parse(r.text);
  assert.equal(p.files.image, undefined);
  assert.match(p.hint, /no page image was saved/);
  assert.ok(!existsSync(source(dir, p.source_id, "page.png")));
  assert.match(readFileSync(p.files.text, "utf8"), /Operating profit 128,339/);
  assert.match(registry(dir).find((x) => x.source_id === p.source_id).image_error, /Timeout/);
  const again = JSON.parse((await acquire(b, { url: "http://filings.regulator.test/long-20f.htm" })).text);
  assert.equal(again.source_id, p.source_id);
  assert.equal(again.files.image, undefined);
  assert.deepEqual(registry(dir).filter((x) => x.source_id === p.source_id).map((x) => x.event), ["acquired", "acquired_again"]);
  const tall = JSON.parse((await acquire(b, { url: "http://filings.regulator.test/tall-ncsr.htm" })).text);
  assert.equal(tall.files.image, undefined);
  assert.match(readFileSync(tall.files.text, "utf8"), /Net assets 9,876,543/);
  assert.match(registry(dir).find((x) => x.source_id === tall.source_id).image_error, /^the page is 50\d\d\d px tall, over the 40000 px image limit$/);
}));

test("a PDF with junk before its header is stored; HTML served as a PDF is refused", () => withBrowser(async (b, dir) => {
  const ok = await acquire(b, { url: "http://cdn.shared.test/space2/prefixed.pdf" });
  assert.equal(ok.error, false, ok.text);
  assert.match(readFileSync(source(dir, JSON.parse(ok.text).source_id, "pages", "0001.txt"), "utf8"), /Prefixed report 42\.0/);
  const bad = await acquire(b, { url: "http://cdn.shared.test/space2/not-a.pdf" });
  assert.equal(bad.error, true);
  assert.match(bad.text, /was served as a PDF but is not one/);
  assert.ok(!registry(dir).some((r) => String(r.final_url).endsWith("not-a.pdf")));
  const broken = await acquire(b, { url: "http://cdn.shared.test/space2/broken.pdf" });
  assert.equal(broken.error, true);
  assert.match(broken.text, /PDF preparation failed: .+/);
  assert.ok(!registry(dir).some((r) => String(r.final_url).endsWith("broken.pdf")));
  assert.equal(readdirSync(join(dir, "sources")).filter((n) => n.startsWith("s")).length, 1);
  assert.deepEqual(readdirSync(join(dir, "sources", ".staging")), [], "a save that failed partway left no staging directory");
}));

test("an xlsx gives one text page per sheet, in workbook order", () => withBrowser(async (b, dir) => {
  const r = await acquire(b, { url: "http://cdn.shared.test/space2/figures.xlsx" });
  assert.equal(r.error, false, r.text);
  const x = JSON.parse(r.text);
  assert.equal(x.kind, "xlsx");
  assert.equal(x.pages, 3);
  assert.deepEqual(registry(dir)[0].sheets, ["Income statement", "Share data", "Notes"]);
  assert.ok(existsSync(source(dir, x.source_id, "original.xlsx")));
  assert.match(readFileSync(source(dir, x.source_id, "pages", "0001.txt"), "utf8"), /^Sheet: Income statement\n.*\nRevenue\t1250\t1190\n/);
  assert.match(readFileSync(source(dir, x.source_id, "pages", "0002.txt"), "utf8"), /^Sheet: Share data\nShares outstanding\t\t74500000\n/);
  assert.match(readFileSync(source(dir, x.source_id, "pages", "0003.txt"), "utf8"), /^Sheet: Notes\n/);
}));

test("a document redirected to a private host is refused before it is fetched; to another public host it is followed", () => withBrowser(async (b, dir) => {
  const r = await acquire(b, { url: "http://cdn.shared.test/space1/moved.pdf" });
  assert.equal(r.error, true);
  assert.match(r.text, /redirect to http:\/\/10\.9\.9\.9\/stolen\.pdf is blocked \(private_host\)/);
  assert.ok(events(b).some((e) => e.type === "rejected" && e.via === "redirect" && e.url === "http://10.9.9.9/stolen.pdf"));
  assert.deepEqual(leaked(["10.9.9.9"]), []);
  await browse(b, { action: "open", url: `${ISSUER}/reports` });
  const cap = await acquire(b, { ref: refOf((await browse(b, { action: "observe", query: "Capital" })).text, "Capital structure") });
  assert.equal(cap.error, false, cap.text);
  const stored = registry(dir).find((x) => x.source_id === JSON.parse(cap.text).source_id);
  assert.equal(stored.final_url, "http://bucket.storage.test/capital.pdf?Signature=x");
  assert.deepEqual(stored.redirects, [{ from: `${ISSUER}/files/via-storage`, to: "http://bucket.storage.test/capital.pdf?Signature=x", status: 302 }]);
}));

test("a host that refuses the request client (403) is fetched through the browser", () => withBrowser(async (b, dir) => {
  await browse(b, { action: "open", url: `${ISSUER}/reports` });
  const page = await acquire(b, { url: "http://filings.regulator.test/q2.htm" });
  assert.equal(page.error, false, page.text);
  const p = JSON.parse(page.text);
  assert.equal(p.kind, "html");
  assert.match(readFileSync(p.files.text, "utf8"), /Net sales 154,944/);
  assert.equal(registry(dir).find((r) => r.source_id === p.source_id).via, "url+browser");
  const doc = await acquire(b, { url: "http://filings.regulator.test/ex99.pdf" });
  assert.equal(doc.error, false, doc.text);
  const pdf = JSON.parse(doc.text);
  assert.equal(pdf.kind, "pdf");
  assert.match(readFileSync(source(dir, pdf.source_id, "pages", "0001.txt"), "utf8"), /Operating profit 72,240/);
  const viewer = await acquire(b, { url: "http://filings.regulator.test/ix" });
  assert.equal(viewer.error, true);
  assert.match(viewer.text, /has no text of its own; nothing was saved\. Its content is in frames: http:\/\/filings\.regulator\.test\/q2\.htm/);
  assert.ok(!registry(dir).some((r) => String(r.final_url).endsWith("/ix")));
}));

test("downloads and document tabs a click opens are saved by code, also one that finishes after the reply", { timeout: 120_000 }, () => withBrowser(async (b, dir) => {
  await browse(b, { action: "open", url: `${ISSUER}/reports` });
  const q = await browse(b, { action: "click", ref: refOf((await browse(b, { action: "observe", query: "Quarterly" })).text, `link "Quarterly results"`) });
  assert.equal(q.error, false, q.text);
  const [download] = JSON.parse(q.text).downloads;
  assert.match(download.source_id, /^s[0-9a-f]{10}$/);
  assert.match(readFileSync(source(dir, download.source_id, "pages", "0001.txt"), "utf8"), /Quarter 7\.40/);
  const rec = registry(dir).find((x) => x.source_id === download.source_id);
  assert.equal(rec.via, "download");
  assert.equal(rec.parent_url, `${ISSUER}/reports`);

  await browse(b, { action: "open", url: `${ISSUER}/presentations` });
  const late = await browse(b, { action: "click", ref: refOf((await browse(b, { action: "observe", query: "download announcement" })).text, "Download announcement") });
  assert.equal(late.error, false, late.text);
  assert.doesNotMatch(late.text, /source_id/);
  await new Promise((ok) => setTimeout(ok, 4000));
  const next = await browse(b, { action: "observe", query: "presentations" });
  assert.match(next.text, /"downloads_finished_since_last_call"[\s\S]*"source_id": "s[0-9a-f]{10}"/);
  assert.match(next.text, /heading "Presentations"/);

  await browse(b, { action: "open", url: `${ISSUER}/investors` });
  const tab = await browse(b, { action: "click", ref: refOf((await browse(b, { action: "observe", query: "presentation.pdf" })).text, "Presentation.pdf") });
  assert.equal(tab.error, false, tab.text);
  assert.match(tab.text, /"source_id": "s[0-9a-f]{10}"/);
  const deck = registry(dir).findLast((x) => x.via === "new_tab");
  assert.equal(deck.final_url, "http://ir.issuer.test/files/fy2025-presentation.pdf");
  assert.equal(deck.parent_url, `${ISSUER}/investors`);
  assert.equal(deck.link_text, "Presentation.pdf");
  assert.equal((await browse(b, { action: "tabs" })).text.split("\n").length, 1, "the document tab was closed");
}));

test("a late download is reported with the next call, not taken for that call's own page or document", { timeout: 120_000 }, () => withBrowser(async (b) => {
  const lateClick = async () => {
    await browse(b, { action: "open", url: `${ISSUER}/presentations` });
    const late = await browse(b, { action: "click", ref: refOf((await browse(b, { action: "observe", query: "download announcement" })).text, "Download announcement") });
    assert.doesNotMatch(late.text, /source_id/);
    await new Promise((ok) => setTimeout(ok, 4000));
  };
  await lateClick();
  const opened = await browse(b, { action: "open", url: `${ISSUER}/reports` });
  assert.equal(opened.error, false, opened.text);
  const page = JSON.parse(opened.text);
  assert.equal(page.url, `${ISSUER}/reports`);
  assert.match(page.downloads_finished_since_last_call[0].source_id, /^s[0-9a-f]{10}$/);
  await lateClick();
  const r = await acquire(b, { url: "http://filings.regulator.test/q2.htm" });
  assert.equal(r.error, false, r.text);
  const saved = JSON.parse(r.text);
  assert.equal(saved.kind, "html");
  assert.equal(saved.final_url, "http://filings.regulator.test/q2.htm");
  assert.match(saved.downloads_finished_since_last_call[0].source_id, /^s[0-9a-f]{10}$/);
}));

test("without a save_dir acquire fails naming it, and a download is reported as not saved", () => withBrowser(async (b) => {
  await browse(b, { action: "open", url: `${ISSUER}/reports` });
  const r = await acquire(b, { current_page: true });
  assert.equal(r.error, true);
  assert.match(r.text, /started without save_dir/);
  const q = await browse(b, { action: "click", ref: refOf((await browse(b, { action: "observe", query: "Quarterly" })).text, `link "Quarterly results"`) });
  const [download] = JSON.parse(q.text).downloads;
  assert.equal(download.not_saved, `${ISSUER}/files/q.pdf`);
  assert.match(download.reason, /started without save_dir/);
}, { save: false }));

test("a relative, missing or non-directory save_dir fails at start, naming it", async () => {
  for (const [dir, pattern] of [["relative/dir", /save_dir must be an absolute path: relative\/dir/],
    [join(root, "missing"), /save_dir is not an existing directory/], ["/etc/hostname", /save_dir is not an existing directory/]]) {
    const r = await call("start", { save_dir: dir });
    assert.equal(r.error, true, dir);
    assert.match(r.text, pattern);
  }
});

test("two browsers with different save_dirs save into their own; two on one save_dir get one source_id and one intact registry", { timeout: 120_000 }, async () => {
  const [one, two] = [newSaveDir(), newSaveDir()];
  await withBrowser(async (b1) => withBrowser(async (b2) => {
    const [r1, r2] = await Promise.all([acquire(b1, { url: "http://cdn.shared.test/space1/ar-2024.pdf" }),
      acquire(b2, { url: "http://cdn.shared.test/space2/other.pdf" })]);
    assert.equal(r1.error, false, r1.text);
    assert.equal(r2.error, false, r2.text);
    assert.deepEqual(registry(one).map((x) => x.source_id), [JSON.parse(r1.text).source_id]);
    assert.deepEqual(registry(two).map((x) => x.source_id), [JSON.parse(r2.text).source_id]);
  }, { saveDir: two }), { saveDir: one });

  const shared = newSaveDir();
  await withBrowser(async (b1) => withBrowser(async (b2) => {
    const rs = await Promise.all([b1, b2].map((b) => acquire(b, { url: "http://cdn.shared.test/space1/ar-2025.pdf" })));
    for (const r of rs) assert.equal(r.error, false, r.text);
    const ids = rs.map((r) => JSON.parse(r.text).source_id);
    assert.equal(ids[0], ids[1]);
    assert.deepEqual(registry(shared).map((x) => x.event).sort(), ["acquired", "acquired_again"]);
    assert.deepEqual(readdirSync(join(shared, "sources")).filter((n) => !n.startsWith(".")).sort(), ["registry.jsonl", ids[0]]);
    assert.deepEqual(readdirSync(join(shared, "sources", ".staging")), [], "the save that lost the race removed its staging directory");
    assert.equal(rs.filter((r) => JSON.parse(r.text).note === "already acquired; same bytes and source id").length, 1);
  }, { saveDir: shared }), { saveDir: shared });
});

test("a slow document preparation in one browser does not hold up another browser's save into the same save_dir", { timeout: 120_000 }, async () => {
  const PREPARE_MS = 8_000;
  const slow = await daemon("slow", { BROWSER_TEST_PREPARE_MS: String(PREPARE_MS) });
  const shared = newSaveDir();
  const begin = async () => JSON.parse((await call("start", { save_dir: shared }, slow.client)).text).browser;
  const [b1, b2] = [await begin(), await begin()];
  try {
    for (const b of [b1, b2]) assert.equal((await call("browse", { browser: b, action: "open", url: `${ISSUER}/reports` }, slow.client)).error, false);
    const t0 = Date.now();
    let aDone = null;
    const a = call("acquire", { browser: b1, url: "http://cdn.shared.test/space1/ar-2025.pdf" }, slow.client).then((r) => {
      aDone = Date.now();
      return r;
    });
    await new Promise((ok) => setTimeout(ok, 2_000)); // A is fetched and inside its preparation
    const page = await call("acquire", { browser: b2, current_page: true }, slow.client);
    const bDone = Date.now();
    assert.equal(page.error, false, page.text);
    assert.equal(aDone, null, "B's save finished while A was still preparing");
    assert.ok(bDone - t0 < PREPARE_MS, `B finished ${bDone - t0} ms after A began, within A's ${PREPARE_MS} ms preparation`);
    const doc = await a;
    assert.equal(doc.error, false, doc.text);
    assert.deepEqual(registry(shared).map((x) => x.kind), ["html", "pdf"]);
    assert.deepEqual(readdirSync(join(shared, "sources", ".staging")), []);
  } finally {
    await call("close", { browser: b1 }, slow.client);
    await call("close", { browser: b2 }, slow.client);
  }
});

test("nothing is written outside each save_dir's sources, and the daemon keeps no source", () => {
  for (const dir of saveDirs) {
    const top = readdirSync(dir);
    assert.ok(top.length === 0 || (top.length === 1 && top[0] === "sources"), `${dir}: ${top}`);
  }
  for (const one of daemons) {
    assert.deepEqual(readdirSync(one.stateDir).sort(), ["downloads", "logs", "profiles"]);
    assert.deepEqual(readdirSync(join(one.stateDir, "downloads")), [], "no download outlives its browser");
    assert.ok(readdirSync(join(one.stateDir, "logs")).every((n) => n.endsWith(".jsonl")));
  }
});
