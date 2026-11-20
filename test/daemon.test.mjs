// End-to-end tests of the browser daemon over Streamable HTTP MCP, with a local forward proxy that plays the
// internet (an issuer site, a shared document CDN, third parties), and a local recorder that plays the search
// services. Network-free; needs Chrome and Xvfb.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request } from "node:http";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startFixtureSite } from "./fixture-site.mjs";

const DAEMON = resolve(import.meta.dirname, "../src/daemon.mjs");
const LIMIT_MS = 20_000;
const ISSUER = "http://ir.issuer.test";

const KEY = "test-key-" + randomBytes(8).toString("hex");
const NEWS_XML = readFileSync(join(import.meta.dirname, "fixtures/news/google-news-search.xml"), "utf8");
const DECODED = "https://www.wsj.com/tech/example-widgets-regulator-probe";

let site;
let recorder;
let hits;
let root;
let main;
const daemons = [];
const clients = [];

async function freePort() {
  const probe = createServer();
  await new Promise((ok) => probe.listen(0, "127.0.0.1", ok));
  const { port } = probe.address();
  await new Promise((ok) => probe.close(ok));
  return port;
}

/** Spawn the daemon on a fresh state directory (or the given one); resolves once it listens. */
async function daemon(env = {}, stateDir = mkdtempSync(join(root, "state-"))) {
  // Each daemon gets a profile root of its own, so one daemon's crash stand-in never kills another's Chrome.
  const profileRoot = env.BROWSER_PROFILE_ROOT ?? mkdtempSync(join(root, "named-"));
  const port = await freePort();
  const proc = spawn(process.execPath, [DAEMON], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env,
    BROWSER_PORT: String(port), BROWSER_BASE_PROFILE: join(root, "base"), BROWSER_STATE_DIR: stateDir,
    BROWSER_PROFILE_ROOT: profileRoot, BROWSER_MINIMAX_KEY: KEY, BROWSER_TEST_SEARCH_ORIGIN: recorder.url, BROWSER_TEST_PROXY: site.url, BROWSER_TEST_CALL_LIMIT_MS: String(LIMIT_MS), ...env } });
  const d = { proc, port, stateDir, profileRoot, url: `http://127.0.0.1:${port}/mcp`, stderr: "",
    exited: new Promise((ok) => proc.once("exit", ok)) };
  daemons.push(d);
  await new Promise((ok, err) => {
    proc.stderr.on("data", (chunk) => {
      d.stderr += chunk;
      process.stderr.write(chunk);
      if (d.stderr.includes("listening on")) ok();
    });
    d.exited.then((code) => err(new Error(`daemon exited with ${code}: ${d.stderr}`)));
  });
  return d;
}

/** A local recorder that plays MiniMax's search API and Google News, and records every request it gets. */
async function startRecorder() {
  const seen = [];
  const server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const entry = { method: req.method, url: req.url, headers: req.headers, body, aborted: false };
      seen.push(entry);
      const json = (status, value) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      if (req.method === "POST" && req.url === "/v1/coding_plan/search") {
        const q = JSON.parse(body).q;
        if (q === "hang") return void res.on("close", () => { entry.aborted = !res.writableEnded; });
        if (q === "fail") return json(503, {});
        if (q === "denied") return json(401, {});
        if (q === "quota") return json(200, { base_resp: { status_code: 1008, status_msg: "insufficient balance" } });
        return json(200, { organic: [{ title: "Result for " + q, link: `${ISSUER}/reports`, snippet: "Annual reports", date: "2026-03-03" }],
          base_resp: { status_code: 0 } });
      }
      if (req.url.startsWith("/rss/search")) return void res.writeHead(200, { "content-type": "application/xml" }).end(NEWS_XML);
      if (req.url.startsWith("/rss/articles/")) {
        return void res.writeHead(200, { "content-type": "text/html" }).end(`<div data-n-a-sg="sig" data-n-a-ts="1763400000"></div>`);
      }
      if (req.method === "POST" && req.url === "/_/DotsSplashUi/data/batchexecute") {
        const answer = [["wrb.fr", "Fbv4je", JSON.stringify(["garturlres", DECODED, 1]), null, null, null, "0"]];
        return void res.writeHead(200).end(`)]}'\n\n${JSON.stringify(answer)}`);
      }
      res.writeHead(404).end();
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { server, seen, url: `http://127.0.0.1:${server.address().port}` };
}

async function client(url) {
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(url)));
  clients.push(c);
  return c;
}

async function call(c, name, args) {
  const t0 = Date.now();
  const r = await c.callTool({ name, arguments: args });
  const t1 = Date.now();
  return { error: !!r.isError, text: r.content.filter((x) => x.type === "text").map((x) => x.text).join("\n"), t0, t1 };
}

async function start(c, args = {}) {
  const r = await call(c, "start", args);
  assert.equal(r.error, false, r.text);
  return JSON.parse(r.text).browser;
}

const browse = (c, browser, args) => call(c, "browse", { browser, ...args });
const events = (stateDir, handle) => readFileSync(join(stateDir, "logs", `${handle}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Processes that belong to a daemon: Chromes (by their profile path, in the state directory or the profile root) and Xvfbs (by the pids it logged). */
function ownProcesses(stateDir, profileRoot) {
  const found = [];
  for (const pid of readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (cmdline.includes(stateDir) || (profileRoot && cmdline.includes(profileRoot))) found.push(Number(pid));
    } catch {}
  }
  const logs = join(stateDir, "logs");
  for (const name of existsSync(logs) ? readdirSync(logs) : []) {
    for (const e of events(stateDir, name.replace(/\.jsonl$/, ""))) if (e.xvfb_pid && alive(e.xvfb_pid)) found.push(e.xvfb_pid);
  }
  return found;
}

const overlap = (rs) => Math.max(...rs.map((r) => r.t0)) < Math.min(...rs.map((r) => r.t1));

before(async () => {
  site = await startFixtureSite();
  recorder = await startRecorder();
  hits = site.hits;
  root = mkdtempSync(join(tmpdir(), "browser-mcp-"));
  mkdirSync(join(root, "base"));
  main = await daemon();
});

after(async () => {
  await Promise.allSettled(clients.map((c) => c.close()));
  for (const d of daemons) d.proc.kill("SIGTERM");
  await Promise.all(daemons.map((d) => d.exited));
  site?.server.close();
  recorder?.server.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("a page opens with its third-party content; open needs a url", async () => {
  const c = await client(main.url);
  const b = await start(c);
  const r = await browse(c, b, { action: "open", url: `${ISSUER}/investors` });
  assert.equal(r.error, false, r.text);
  assert.match(r.text, /Issuer results text/);
  assert.ok(hits.includes("widget.thirdparty.test/quote"), "the widget frame loads");
  assert.ok(hits.includes("api.thirdparty.test/quote"), "the third-party API loads");
  const none = await browse(c, b, { action: "open" });
  assert.equal(none.error, true);
  assert.match(none.text, /open needs url/);
  const misplaced = await browse(c, b, { action: "text", url: `${ISSUER}/reports` });
  assert.match(misplaced.text, /text takes page, not url: open the url first/);
  await call(c, "close", { browser: b });
});

test("a document is not a page: the tab goes back and the next read still works", async () => {
  const c = await client(main.url);
  const b = await start(c);
  await browse(c, b, { action: "open", url: `${ISSUER}/reports` });
  const doc = await browse(c, b, { action: "open", url: "http://cdn.shared.test/space1/ar-2024.pdf" });
  assert.equal(doc.error, true);
  assert.match(doc.text, /is a document, not a page.*the tab is back on http:\/\/ir\.issuer\.test\/reports/);
  const t = await browse(c, b, { action: "text" });
  assert.match(t.text, /Report archive/);
  await call(c, "close", { browser: b });
});

test("text reads in pages; a select shows as its chosen option and size", async () => {
  const c = await client(main.url);
  const b = await start(c);
  await browse(c, b, { action: "open", url: `${ISSUER}/reports` });
  assert.match((await browse(c, b, { action: "text" })).text, /text page 1 of 1/);
  await browse(c, b, { action: "open", url: "http://register.exchange.test/notices" });
  const t = (await browse(c, b, { action: "text" })).text;
  assert.match(t, /\[select: All \(62 options\)\]/);
  assert.doesNotMatch(t, /Issuer 00 AG/);
  await call(c, "close", { browser: b });
});

const PAGES = [["investors", "Issuer results text"], ["reports", "Report archive"],
  ["presentations", "Full-year results 2025 presentation"], ["date-search", "Disclosure search"]];
let four;

test("four callers at once each read only their own page, and their calls overlap", { timeout: 120_000 }, async () => {
  const cs = await Promise.all(PAGES.map(() => client(main.url)));
  const handles = await Promise.all(cs.map(start));
  const opened = await Promise.all(cs.map((c, i) => browse(c, handles[i], { action: "open", url: `${ISSUER}/${PAGES[i][0]}` })));
  for (const r of opened) assert.equal(r.error, false, r.text);
  assert.ok(overlap(opened), "the opens ran at the same time");
  const texts = await Promise.all(cs.map((c, i) => browse(c, handles[i], { action: "text" })));
  texts.forEach((r, i) => {
    assert.match(r.text, new RegExp(PAGES[i][1]));
    PAGES.forEach(([, marker], j) => { if (j !== i) assert.doesNotMatch(r.text, new RegExp(marker)); });
  });
  four = { cs, handles };
});

test("one caller closes; the other three still read their pages", async () => {
  const { cs, handles } = four;
  assert.equal((await call(cs[0], "close", { browser: handles[0] })).error, false);
  for (const i of [1, 2, 3]) {
    const r = await browse(cs[i], handles[i], { action: "text" });
    assert.equal(r.error, false, r.text);
    assert.match(r.text, new RegExp(PAGES[i][1]));
  }
  const gone = await browse(cs[0], handles[0], { action: "text" });
  assert.equal(gone.error, true);
  assert.match(gone.text, /unknown browser/);
});

test("a fifth start fails at once, naming the cap; after a close, start works", async () => {
  const { cs, handles } = four;
  const extra = await start(cs[0]); // three live from the last test, now four
  const t = Date.now();
  const r = await call(cs[0], "start", {});
  assert.equal(r.error, true);
  assert.ok(Date.now() - t < 1000, "no queue");
  assert.match(r.text, /4 browsers are running, at the cap of 4/);
  await call(cs[1], "close", { browser: handles[1] });
  const again = await start(cs[0]);
  for (const [c, h] of [[cs[0], extra], [cs[0], again], [cs[2], handles[2]], [cs[3], handles[3]]]) await call(c, "close", { browser: h });
});

test("two browsers on one connection run at the same time", { timeout: 120_000 }, async () => {
  const c = await client(main.url);
  const [a, b] = [await start(c), await start(c)];
  const rs = await Promise.all([browse(c, a, { action: "open", url: `${ISSUER}/investors` }),
    browse(c, b, { action: "open", url: `${ISSUER}/reports` })]);
  assert.match(rs[0].text, /Issuer results text/);
  assert.match(rs[1].text, /Report archive/);
  assert.ok(overlap(rs));
  await call(c, "close", { browser: a });
  await call(c, "close", { browser: b });
});

test("a missing or unknown handle fails clearly and touches no browser", async () => {
  const c = await client(main.url);
  const b = await start(c);
  await browse(c, b, { action: "open", url: `${ISSUER}/reports` });
  const before = events(main.stateDir, b).length;
  assert.equal((await call(c, "browse", { action: "text" })).error, true);
  const r = await browse(c, "nope", { action: "text" });
  assert.equal(r.error, true);
  assert.match(r.text, /unknown browser \\"nope\\".*call start/);
  assert.equal(events(main.stateDir, b).length, before);
  assert.match((await browse(c, b, { action: "text" })).text, /Report archive/);
  await call(c, "close", { browser: b });
});

test("a call over its limit fails and restarts only that browser, which keeps its cookies", { timeout: 120_000 }, async () => {
  const c = await client(main.url);
  const [a, b] = [await start(c), await start(c)];
  await browse(c, a, { action: "open", url: `${ISSUER}/set-cookie?v=a1` });
  await browse(c, b, { action: "open", url: `${ISSUER}/reports` });
  const started = Date.now();
  const [hang, other] = await Promise.all([browse(c, a, { action: "open", url: `${ISSUER}/hang` }),
    browse(c, b, { action: "text" })]);
  assert.equal(hang.error, true);
  assert.match(hang.text, /ran over its 20 s limit and was stopped; the browser was restarted: open a page again/);
  assert.ok(Date.now() - started < LIMIT_MS + 10_000);
  assert.ok(events(main.stateDir, a).some((e) => e.type === "browser_reset"));
  assert.equal(other.error, false, other.text);
  assert.match(other.text, /Report archive/);
  assert.ok(other.t1 < hang.t1, "the other browser was not held up by the hang");
  const next = await browse(c, a, { action: "open", url: `${ISSUER}/show-cookie` });
  assert.equal(next.error, false, next.text);
  assert.match(next.text, /Cookie: visit=a1/);
  await call(c, "close", { browser: a });
  await call(c, "close", { browser: b });
});

test("a named profile keeps its cookies across browsers and stays after close; a throwaway copy is still deleted", { timeout: 120_000 }, async () => {
  const c = await client(main.url);
  mkdirSync(join(main.profileRoot, "keep"));
  const first = await start(c, { profile: "keep" });
  await browse(c, first, { action: "open", url: `${ISSUER}/set-cookie?v=n1` });
  await call(c, "close", { browser: first });
  assert.ok(readdirSync(join(main.profileRoot, "keep")).length > 0, "Chrome wrote its profile and close left it");
  const second = await start(c, { profile: "keep" });
  const shown = await browse(c, second, { action: "open", url: `${ISSUER}/show-cookie` });
  assert.match(shown.text, /Cookie: visit=n1/);
  await call(c, "close", { browser: second });
  const copy = await start(c);
  await browse(c, copy, { action: "open", url: `${ISSUER}/reports` });
  await call(c, "close", { browser: copy });
  assert.equal(existsSync(join(main.stateDir, "profiles", copy)), false);
});

test("a second start on a held profile fails at once, naming the holder; after close it works", { timeout: 120_000 }, async () => {
  const c = await client(main.url);
  mkdirSync(join(main.profileRoot, "held"));
  const h1 = await start(c, { profile: "held" });
  await browse(c, h1, { action: "open", url: `${ISSUER}/reports` });
  const second = await call(c, "start", { profile: "held" });
  assert.equal(second.error, true);
  assert.ok(second.t1 - second.t0 < 1000);
  assert.match(second.text, /is in use by browser/);
  assert.ok(second.text.includes(h1.slice(0, 6) + "…"));
  assert.ok(!second.text.includes(h1), "the refusal must not carry the full handle");
  await call(c, "close", { browser: h1 });
  await call(c, "close", { browser: await start(c, { profile: "held" }) });
});

test("bad profile names fail clearly and start nothing", async () => {
  const c = await client(main.url);
  mkdirSync(join(main.profileRoot, "target"), { recursive: true });
  symlinkSync(join(main.profileRoot, "target"), join(main.profileRoot, "link"));
  const clones = () => readdirSync(join(main.stateDir, "profiles"));
  const before = clones();
  for (const [name, pattern] of [["../x", /not a profile name/], ["a/b", /not a profile name/], ["..", /not a profile name/],
    ["missing", /no profile/], ["link", /not a plain directory/]]) {
    const r = await call(c, "start", { profile: name });
    assert.equal(r.error, true, name);
    assert.match(r.text, pattern, name);
  }
  assert.deepEqual(clones(), before);
});

test("a restart after a time limit keeps the hold, and the handle still works on the profile", { timeout: 120_000 }, async () => {
  const c = await client(main.url);
  mkdirSync(join(main.profileRoot, "restart"));
  const h = await start(c, { profile: "restart" });
  await browse(c, h, { action: "open", url: `${ISSUER}/set-cookie?v=r1` });
  const hang = await browse(c, h, { action: "open", url: `${ISSUER}/hang` });
  assert.equal(hang.error, true);
  assert.match(hang.text, /ran over its 20 s limit.*the browser was restarted/);
  assert.ok(events(main.stateDir, h).some((e) => e.type === "browser_reset"));
  const again = await call(c, "start", { profile: "restart" });
  assert.equal(again.error, true);
  assert.ok(again.text.includes(h.slice(0, 6) + "…"));
  assert.ok(!again.text.includes(h));
  const shown = await browse(c, h, { action: "open", url: `${ISSUER}/show-cookie` });
  assert.equal(shown.error, false, shown.text);
  assert.match(shown.text, /Cookie: visit=r1/);
  await call(c, "close", { browser: h });
});

test("after a crash, a new daemon opens the named profile", { timeout: 120_000 }, async () => {
  const d = await daemon();
  mkdirSync(join(d.profileRoot, "crash"));
  const c = await client(d.url);
  const h = await start(c, { profile: "crash" });
  await browse(c, h, { action: "open", url: `${ISSUER}/set-cookie?v=c1` });
  d.proc.kill("SIGKILL");
  await d.exited;
  for (const pid of ownProcesses(d.stateDir, d.profileRoot)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  assert.ok(existsSync(join(d.profileRoot, "crash")));
  const d2 = await daemon({ BROWSER_PROFILE_ROOT: d.profileRoot }, d.stateDir);
  const c2 = await client(d2.url);
  const h2 = await start(c2, { profile: "crash" });
  const shown = await browse(c2, h2, { action: "open", url: `${ISSUER}/show-cookie` });
  assert.match(shown.text, /visit=c1/);
  await call(c2, "close", { browser: h2 });
  assert.ok(existsSync(join(d.profileRoot, "crash")));
});

test("a Host header that is not local is refused", async () => {
  const post = (host) => new Promise((ok, err) => {
    const req = request({ host: "127.0.0.1", port: main.port, path: "/mcp", method: "POST",
      headers: { host, "content-type": "application/json", accept: "application/json, text/event-stream" } }, (res) => {
      res.resume();
      res.on("end", () => ok(res.statusCode));
    });
    req.on("error", err);
    req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }));
  });
  assert.equal(await post("evil.example"), 403);
  assert.notEqual(await post(`127.0.0.1:${main.port}`), 403);
});

test("an idle browser is closed and its profile copy deleted", { timeout: 120_000 }, async () => {
  const d = await daemon({ BROWSER_TEST_IDLE_MS: "3000" });
  const c = await client(d.url);
  const b = await start(c);
  assert.equal((await browse(c, b, { action: "open", url: `${ISSUER}/reports` })).error, false);
  await new Promise((ok) => setTimeout(ok, 8000));
  assert.equal(existsSync(join(d.stateDir, "profiles", b)), false);
  assert.ok(events(d.stateDir, b).some((e) => e.type === "closed" && e.reason === "idle"));
  assert.match((await browse(c, b, { action: "text" })).text, /unknown browser/);
  assert.deepEqual(ownProcesses(d.stateDir, d.profileRoot), []);
});

// On SIGINT patchright's own handler exits the process while the daemon's closes are still under way.
for (const signal of ["SIGTERM", "SIGINT"]) test(`after ${signal} no Chrome, Xvfb or profile copy is left`, { timeout: 120_000 }, async () => {
  const d = await daemon();
  const c = await client(d.url);
  for (const url of [`${ISSUER}/reports`, `${ISSUER}/investors`, `${ISSUER}/presentations`]) {
    const b = await start(c);
    assert.equal((await browse(c, b, { action: "open", url })).error, false);
  }
  assert.ok(ownProcesses(d.stateDir, d.profileRoot).length > 0);
  d.proc.kill(signal);
  await d.exited;
  // The exit hook only signals each Xvfb: give them a moment to go.
  for (let i = 0; i < 30 && ownProcesses(d.stateDir, d.profileRoot).length; i++) await new Promise((ok) => setTimeout(ok, 100));
  assert.deepEqual(ownProcesses(d.stateDir, d.profileRoot), []);
  assert.deepEqual(readdirSync(join(d.stateDir, "profiles")), []);
});

test("a daemon started after a killed one deletes its leftover profile copies and old logs", { timeout: 120_000 }, async () => {
  const d = await daemon();
  const c = await client(d.url);
  const b = await start(c);
  assert.equal((await browse(c, b, { action: "open", url: `${ISSUER}/reports` })).error, false);
  const old = join(d.stateDir, "logs", "old.jsonl");
  writeFileSync(old, "{}\n");
  const longAgo = new Date(Date.now() - 31 * 24 * 3_600_000);
  utimesSync(old, longAgo, longAgo);
  d.proc.kill("SIGKILL");
  await d.exited;
  // What systemd's control-group kill does to the leftovers.
  for (const pid of ownProcesses(d.stateDir, d.profileRoot)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  assert.ok(existsSync(join(d.stateDir, "profiles", b)), "the crash left the copy");
  await daemon({}, d.stateDir);
  assert.deepEqual(readdirSync(join(d.stateDir, "profiles")), []);
  assert.equal(existsSync(old), false);
  assert.ok(existsSync(join(d.stateDir, "logs", `${b}.jsonl`)), "a recent log stays");
});

// Searches need no browser: every test below runs on a daemon of its own and launches no Chrome.
const searchReplies = [];
const searchDaemons = [];
async function searcher() {
  const d = await daemon();
  searchDaemons.push(d);
  return { d, c: await client(d.url) };
}
async function searched(c, name, args) {
  const r = await call(c, name, args);
  searchReplies.push(r.text);
  return r;
}

test("search returns the engine's results as title, url, snippet and date", async () => {
  const { c } = await searcher();
  const before = recorder.seen.length;
  const r = await searched(c, "search", { query: "Example Widgets annual report 2025" });
  assert.equal(r.error, false, r.text);
  assert.deepEqual(JSON.parse(r.text), [{ title: "Result for Example Widgets annual report 2025",
    url: `${ISSUER}/reports`, snippet: "Annual reports", date: "2026-03-03" }]);
  const seen = recorder.seen.slice(before).find((e) => e.url === "/v1/coding_plan/search");
  assert.equal(seen.headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(JSON.parse(seen.body), { q: "Example Widgets annual report 2025" });
});

test("news_search returns the range's decoded headlines without a browser", async () => {
  const { c } = await searcher();
  const before = recorder.seen.length;
  const r = await searched(c, "news_search", { query: "Example Widgets AG", from: "2026-11-13", to: "2026-11-18" });
  assert.equal(r.error, false, r.text);
  const out = JSON.parse(r.text);
  assert.deepEqual(out.items.map((i) => [i.outlet, i.site, i.published.slice(0, 10)]),
    [["WSJ", "https://www.wsj.com", "2026-11-17"], ["Reuters", "https://www.reuters.com", "2026-11-16"]]);
  assert.equal(out.items[0].url, DECODED);
  assert.equal(out.edition, "US");
  const news = recorder.seen.slice(before);
  assert.equal(new URL(news[0].url, "http://x").searchParams.get("ceid"), "US:en");
  assert.ok(news.length > 2 && news.every((e) => e.headers.cookie === "SOCS=CAI"));
});

test("news_search refuses a day that is not on the calendar, and a range that ends before it starts", async () => {
  const { c } = await searcher();
  const before = recorder.seen.length;
  const bad = await searched(c, "news_search", { query: "Example Widgets AG", from: "2026-02-30", to: "2026-03-01" });
  assert.equal(bad.error, true);
  assert.match(bad.text, /not a calendar day/);
  const reversed = await searched(c, "news_search", { query: "Example Widgets AG", from: "2026-11-18", to: "2026-11-13" });
  assert.equal(reversed.error, true);
  assert.match(reversed.text, /from 2026-11-18 is after to 2026-11-13/);
  assert.equal(recorder.seen.length, before, "nothing was asked of Google");
});

test("neither search needs a start or a handle", async () => {
  const { d, c } = await searcher();
  assert.equal((await searched(c, "search", { query: "Example Widgets" })).error, false);
  assert.equal((await searched(c, "news_search", { query: "Example Widgets AG", from: "2026-11-13", to: "2026-11-18" })).error, false);
  assert.deepEqual(readdirSync(join(d.stateDir, "profiles")), []);
  assert.deepEqual(ownProcesses(d.stateDir, d.profileRoot), []);
});

test("a search over its limit fails with an error result and its request is aborted", { timeout: 60_000 }, async () => {
  const { c } = await searcher();
  const r = await searched(c, "search", { query: "hang" });
  assert.equal(r.error, true);
  assert.match(r.text, /search ran over its 20 s limit and was stopped/);
  for (let i = 0; i < 50 && !recorder.seen.some((e) => e.aborted); i++) await new Promise((ok) => setTimeout(ok, 100));
  assert.ok(recorder.seen.some((e) => e.aborted), "the recorder saw the request closed");
});

test("a provider error fails with its status", async () => {
  const { c } = await searcher();
  assert.match((await searched(c, "search", { query: "fail" })).text, /HTTP 503/);
  assert.match((await searched(c, "search", { query: "denied" })).text, /the MiniMax key was refused \(HTTP 401\)/);
  const quota = await searched(c, "search", { query: "quota" });
  assert.equal(quota.error, true);
  assert.match(quota.text, /MiniMax error 1008: insufficient balance/);
});

/** Spawn the daemon directly, with only the given variables, and collect its exit code and stderr. */
async function spawnRaw(env) {
  const proc = spawn(process.execPath, [DAEMON], { stdio: ["ignore", "ignore", "pipe"],
    env: { PATH: process.env.PATH, BROWSER_PORT: String(await freePort()), BROWSER_BASE_PROFILE: join(root, "base"),
      BROWSER_STATE_DIR: mkdtempSync(join(root, "state-")), BROWSER_PROFILE_ROOT: mkdtempSync(join(root, "named-")), ...env } });
  let stderr = "";
  proc.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 5_000);
  const code = await new Promise((ok) => proc.once("exit", ok));
  clearTimeout(timer);
  return { code, stderr };
}

test("the daemon without the key exits at once, naming the variable", async () => {
  const r = await spawnRaw({});
  assert.equal(r.code, 1);
  assert.match(r.stderr, /BROWSER_MINIMAX_KEY is required/);
});

test("the daemon without BROWSER_PROFILE_ROOT, or with one that overlaps the base profile or the copies, exits at once", async () => {
  const none = await spawnRaw({ BROWSER_MINIMAX_KEY: KEY, BROWSER_PROFILE_ROOT: "" });
  assert.equal(none.code, 1);
  assert.match(none.stderr, /BROWSER_PROFILE_ROOT is required/);
  const base = await spawnRaw({ BROWSER_MINIMAX_KEY: KEY, BROWSER_PROFILE_ROOT: join(root, "base") });
  assert.equal(base.code, 1);
  assert.match(base.stderr, /must not be, contain or sit inside BROWSER_BASE_PROFILE/);
  const state = mkdtempSync(join(root, "state-"));
  mkdirSync(join(state, "profiles", "keepme"), { recursive: true });
  const clones = await spawnRaw({ BROWSER_MINIMAX_KEY: KEY, BROWSER_STATE_DIR: state, BROWSER_PROFILE_ROOT: join(state, "profiles") });
  assert.equal(clones.code, 1);
  assert.doesNotMatch(clones.stderr, /listening on/);
  assert.ok(existsSync(join(state, "profiles", "keepme")), "nothing was wiped");
});

test("a test search origin off this machine is refused at start", async () => {
  const r = await spawnRaw({ BROWSER_MINIMAX_KEY: KEY, BROWSER_TEST_SEARCH_ORIGIN: "https://search.example.test" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /BROWSER_TEST_SEARCH_ORIGIN/);
  assert.doesNotMatch(r.stderr, /listening on/);
});

test("the key is in no reply and no log line", async () => {
  for (const d of searchDaemons) assert.equal(d.proc.exitCode, null, "a search daemon is still running");
  for (const text of searchReplies) assert.ok(!text.includes(KEY));
  for (const d of [main, ...searchDaemons]) {
    assert.ok(!d.stderr.includes(KEY));
    const logs = join(d.stateDir, "logs");
    for (const name of readdirSync(logs)) assert.ok(!readFileSync(join(logs, name), "utf8").includes(KEY), name);
  }
  const lines = searchDaemons.flatMap((d) => readdirSync(join(d.stateDir, "logs")).filter((n) => /^search-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
    .flatMap((n) => readFileSync(join(d.stateDir, "logs", n), "utf8").trim().split("\n").map((l) => JSON.parse(l))));
  assert.ok(lines.length >= 8);
  for (const l of lines) assert.ok(l.tool && l.args && typeof l.ok === "boolean" && typeof l.ms === "number");
});
