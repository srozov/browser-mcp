// End-to-end tests of the browser daemon over Streamable HTTP MCP, with a local forward proxy that plays the
// internet (an issuer site, a shared document CDN, third parties), and a local recorder that plays the search
// services. Network-free; needs Chrome and Xvfb.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request } from "node:http";
import { randomBytes } from "node:crypto";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TEST_HOSTS, startFixtureSite } from "./fixture-site.mjs";

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
    BROWSER_PROFILE_ROOT: profileRoot, BROWSER_MINIMAX_KEY: KEY, BROWSER_TEST_SEARCH_ORIGIN: recorder.url, BROWSER_TEST_PROXY: site.url, BROWSER_TEST_HOSTS: JSON.stringify(TEST_HOSTS), BROWSER_TEST_CALL_LIMIT_MS: String(LIMIT_MS), ...env } });
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
const leaked = (prefixes) => hits.filter((h) => prefixes.some((p) => h.startsWith(p)));
const proxyPort = (stateDir, handle) => events(stateDir, handle).filter((e) => e.type === "browser_started").at(-1).proxy_port;
const listening = (port) => new Promise((ok) => {
  const socket = connect(port, "127.0.0.1");
  socket.once("connect", () => { socket.destroy(); ok(true); });
  socket.once("error", () => ok(false));
});
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
  assert.deepEqual(leaked(["10.9.9.9"]), [], "nothing reached the private host");
  assert.ok(events(main.stateDir, b).some((e) => e.type === "rejected" && e.via === "fetch" && e.url === "http://10.9.9.9/data" && e.reason === "private_host"));
  const none = await browse(c, b, { action: "open" });
  assert.equal(none.error, true);
  assert.match(none.text, /open needs url/);
  const misplaced = await browse(c, b, { action: "text", url: `${ISSUER}/reports` });
  assert.match(misplaced.text, /text takes page, not url: open the url first/);
  await call(c, "close", { browser: b });
});

test("open refuses local, private, non-http and credentialed targets before navigating", async () => {
  const c = await client(main.url);
  const b = await start(c);
  const before = hits.length;
  for (const url of [`http://127.0.0.1:${main.port}/mcp`, "http://localhost/", "file:///etc/passwd", "http://10.9.9.9/x",
    "http://[::ffff:127.0.0.1]/", "https://user:pw@ir.issuer.test/", "data:text/html,<p>inline</p>"]) {
    const r = await browse(c, b, { action: "open", url });
    assert.equal(r.error, true, url);
    assert.match(r.text, /is blocked \((private_host|scheme|credentials_in_url)\)/, url);
    assert.ok(events(main.stateDir, b).some((e) => e.type === "rejected" && e.via === "open" && e.url === url), url);
  }
  assert.equal(hits.length, before, "no request left the browser");
  const ok = await browse(c, b, { action: "open", url: "http://portal.thirdparty.test/issuer" });
  assert.match(ok.text, /PORTAL FIGURES/);
  await call(c, "close", { browser: b });
});

test("a public name that resolves to a private address, or not at all, is refused for open and for a page's requests", async () => {
  const c = await client(main.url);
  const b = await start(c);
  for (const [host, pattern] of [["rebind.test", "resolves_private 127.0.0.1"], ["inside.test", "resolves_private 10.9.9.9"], ["nowhere.test", "unresolved"]]) {
    const r = await browse(c, b, { action: "open", url: `http://${host}/` });
    assert.equal(r.error, true, host);
    assert.match(r.text, new RegExp(`http://${host}/ is blocked \\(${pattern.replaceAll(".", "\\.")}\\)`), host);
  }
  const page = await browse(c, b, { action: "open", url: `${ISSUER}/policy` });
  assert.equal(page.error, false, page.text);
  assert.match(page.text, /POLICY PAGE/);
  const log = events(main.stateDir, b);
  const has = (url, reason, address) => log.some((e) => e.type === "rejected" && e.via === "fetch" && e.url === url && e.reason === reason && e.address === address);
  assert.ok(has("http://rebind.test/data", "resolves_private", "127.0.0.1"));
  assert.ok(has("http://inside.test/data", "resolves_private", "10.9.9.9"));
  assert.ok(has("http://nowhere.test/data", "unresolved", undefined));
  assert.deepEqual(leaked(["rebind.test", "inside.test", "nowhere.test"]), []);
  await call(c, "close", { browser: b });
});

test("a redirect to a public host is followed; to a private or loopback host the proxy refuses it", async () => {
  const c = await client(main.url);
  const b = await start(c);
  const followed = await browse(c, b, { action: "open", url: `${ISSUER}/redirect-out` });
  assert.equal(followed.error, false, followed.text);
  assert.match(followed.text, /EVIL LANDING/);
  await browse(c, b, { action: "open", url: `${ISSUER}/reports` });
  const moved = await browse(c, b, { action: "open", url: "http://cdn.shared.test/space1/moved.pdf" });
  assert.equal(moved.error, true);
  assert.match(moved.text, /http:\/\/10\.9\.9\.9\/stolen\.pdf is blocked \(private_host\)/);
  assert.ok(events(main.stateDir, b).some((e) => e.type === "rejected" && e.via === "connection" && e.url === "http://10.9.9.9/stolen.pdf" && e.reason === "private_host"));
  const loop = await browse(c, b, { action: "open", url: `${ISSUER}/redirect-loopback` });
  assert.equal(loop.error, true);
  assert.match(loop.text, /http:\/\/127\.0\.0\.1:8081\/landing is blocked \(private_host\)/);
  assert.match(loop.text, /the tab is back on http:\/\/ir\.issuer\.test\/reports/);
  const tls = await browse(c, b, { action: "open", url: `${ISSUER}/redirect-tls` });
  assert.equal(tls.error, true);
  assert.match(tls.text, /10\.9\.9\.9:443 is blocked \(private_host\); the tab is back on http:\/\/ir\.issuer\.test\/reports/);
  assert.ok(events(main.stateDir, b).some((e) => e.type === "rejected" && e.via === "connection" && e.url === "10.9.9.9:443"));
  assert.deepEqual(leaked(["10.9.9.9", "127.0.0.1"]), []);
  assert.match((await browse(c, b, { action: "text" })).text, /Report archive/, "the tab is still on the page it was on");
  await call(c, "close", { browser: b });
});

test("a WebSocket to a public host works; to a private host or a name resolving private it is refused", async () => {
  const c = await client(main.url);
  const b = await start(c);
  const r = await browse(c, b, { action: "open", url: `${ISSUER}/sockets` });
  assert.equal(r.error, false, r.text);
  let t = "";
  for (let i = 0; i < 30 && !/WS rebind\.test ERROR/.test(t); i++) {
    await new Promise((ok) => setTimeout(ok, 300));
    t = (await browse(c, b, { action: "text" })).text;
  }
  assert.match(t, /WS ws\.thirdparty\.test MESSAGE WS OK/);
  assert.match(t, /WS 10\.9\.9\.9 ERROR/);
  assert.match(t, /WS rebind\.test ERROR/);
  const log = events(main.stateDir, b);
  assert.ok(log.some((e) => e.type === "rejected" && e.via === "connection" && e.url === "10.9.9.9:80" && e.reason === "private_host"));
  assert.ok(log.some((e) => e.type === "rejected" && e.via === "connection" && e.url === "rebind.test:80" && e.reason === "resolves_private" && e.address === "127.0.0.1"));
  assert.ok(hits.includes("ws.thirdparty.test/feed"));
  assert.deepEqual(leaked(["10.9.9.9", "rebind.test"]), []);
  await call(c, "close", { browser: b });
});

test("Chrome runs with the policy proxy and the WebRTC flag; the proxy outlives a reset and ends with close", { timeout: 120_000 }, async () => {
  const c = await client(main.url);
  const b = await start(c);
  await browse(c, b, { action: "open", url: `${ISSUER}/reports` });
  const port = proxyPort(main.stateDir, b);
  assert.ok(await listening(port));
  const chrome = readdirSync("/proc").filter((n) => /^\d+$/.test(n)).map((pid) => {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    } catch {
      return [];
    }
  }).find((args) => args.some((a) => a.includes(join(main.stateDir, "profiles", b))));
  assert.ok(chrome, "found Chrome by its profile");
  assert.ok(chrome.includes("--force-webrtc-ip-handling-policy=disable_non_proxied_udp"));
  assert.ok(chrome.includes(`--proxy-server=http://127.0.0.1:${port}`));
  await browse(c, b, { action: "open", url: `${ISSUER}/hang` });
  const again = await browse(c, b, { action: "open", url: `${ISSUER}/reports` });
  assert.equal(again.error, false, again.text);
  assert.equal(proxyPort(main.stateDir, b), port, "the relaunched Chrome reuses the proxy");
  assert.equal(events(main.stateDir, b).filter((e) => e.type === "browser_started").length, 2);
  await call(c, "close", { browser: b });
  assert.equal(await listening(port), false);
});

test("a daemon that stops takes its browsers' proxies with it", { timeout: 120_000 }, async () => {
  const d = await daemon();
  const c = await client(d.url);
  const b = await start(c);
  await browse(c, b, { action: "open", url: `${ISSUER}/reports` });
  const port = proxyPort(d.stateDir, b);
  assert.ok(await listening(port));
  d.proc.kill("SIGTERM");
  await d.exited;
  assert.equal(await listening(port), false);
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

/** A test's own browser, closed however the test ends: a leaked one would count against the cap in later tests. */
async function withBrowser(fn) {
  const c = await client(main.url);
  const b = await start(c);
  try {
    await fn(c, b);
  } finally {
    await call(c, "close", { browser: b });
  }
}

/** The ref of the first observe line holding text (a query line's own ref, not its path's). */
const refOf = (listing, text) => /\[ref=(e\d+)\]/.exec(listing.split("\n").find((l) => l.includes("[ref=") && l.includes(text)) ?? "")?.[1];

test("observe outlines the page with refs; a query keeps each hit's path; a ref expands one part", () => withBrowser(async (c, b) => {
  await browse(c, b, { action: "open", url: `${ISSUER}/reports` });
  const r = await browse(c, b, { action: "observe" });
  assert.equal(r.error, false, r.text);
  assert.match(r.text, /heading "Reports" \[level=1\] \[ref=e\d+\]/);
  assert.match(r.text, /combobox \(label "Report archive"\) \[ref=e\d+\]: 2 options, selected "2026"/);
  assert.match(r.text, /text: 2025 Annual Report \(published 3 March 2026\)\n\s+link "Download pdf" \[ref=e\d+\] -> http:\/\/cdn\.shared\.test\/space1\/ar-2025\.pdf/);
  const q = await browse(c, b, { action: "observe", query: "ar-2025" });
  assert.match(q.text, /1 lines match "ar-2025"/);
  assert.match(q.text, /main \[e\d+\] > list \[e\d+\] > listitem \[e\d+\] > link "Download pdf" \[ref=e\d+\]/);
  assert.doesNotMatch(q.text, /ar-2024/);
  const list = /list \[ref=(e\d+)\]/.exec(r.text)[1];
  const part = await browse(c, b, { action: "observe", ref: list });
  assert.match(part.text, /ref e\d+ in main \[e\d+\], page 1 of 1\nlist \[ref=e\d+\]/);
  assert.match(part.text, /Capital structure/);
  assert.doesNotMatch(part.text, /Report archive/);
  const none = await browse(c, b, { action: "observe", query: "dividend policy" });
  assert.match(none.text, /nothing on the page matches "dividend policy"/);
}));

test("an action refuses arguments it does not take, naming them; a malformed or stale ref says observe again", () => withBrowser(async (c, b) => {
  await browse(c, b, { action: "open", url: `${ISSUER}/reports` });
  const r = await browse(c, b, { action: "observe", url: `${ISSUER}/reports` });
  assert.equal(r.error, true);
  assert.match(r.text, /observe takes query, ref, page, not url: open the url first, then observe/);
  assert.match((await browse(c, b, { action: "click", ref: "e1", value: "x" })).text, /click takes ref, not value/);
  assert.match((await browse(c, b, { action: "tabs", page: 2 })).text, /tabs takes nothing, not page/);
  assert.match((await browse(c, b, { action: "observe", page: 2 })).text, /observe takes page only with a query or a ref/);
  assert.match((await browse(c, b, { action: "click" })).text, /click needs ref/);
  const bad = await browse(c, b, { action: "click", ref: "12" });
  assert.equal(bad.error, true);
  assert.match(bad.text, /\\"12\\" is not a ref: refs look like e12 and come from observe; observe again/);
  const gone = await browse(c, b, { action: "click", ref: "e9999" });
  assert.equal(gone.error, true);
  assert.match(gone.text, /ref e9999 is not on the page now \(it changed or reloaded\); observe again/);
  assert.match((await browse(c, b, { action: "observe", ref: "e9999" })).text, /observe again/);
}));

test("a register: banner, long select, styled checkbox, a date in parts, and results that arrive late", { timeout: 120_000 }, () => withBrowser(async (c, b) => {
  await browse(c, b, { action: "open", url: "http://register.exchange.test/notices" });
  const all = await browse(c, b, { action: "observe" });
  assert.match(all.text, /combobox \(label "ISSUER"\) \[ref=e\d+\]: 62 options, selected "All"/);
  assert.match(all.text, /checkbox "Current notices only" \[checked\] \[ref=e\d+\]/);
  assert.match(all.text, /spinbutton "Year" \[ref=e\d+\]: 2026/);
  assert.doesNotMatch(all.text, /Issuer 00 AG/);
  const o = await browse(c, b, { action: "observe", query: "example widgets" });
  assert.match(o.text, /combobox \(label "ISSUER"\) \[ref=e\d+\]: 62 options, selected "All"\n\s+matching options: "Example Widgets AG"/);
  const select = refOf(o.text, "combobox");
  const search = refOf(all.text, `button "Search"`);
  const checkbox = refOf(all.text, `checkbox "Current notices only"`);
  const blocked = await browse(c, b, { action: "click", ref: search });
  assert.equal(blocked.error, true);
  assert.match(blocked.text, /another element \(consent-banner\) covers it, often a cookie or consent banner/);
  const through = await browse(c, b, { action: "click", ref: refOf(all.text, `checkbox "Include archived"`) });
  assert.equal(through.error, true, "a checkbox under the banner is not ticked through it");
  assert.match(through.text, /another element \(consent-banner\) covers it/);
  assert.equal((await browse(c, b, { action: "click", ref: refOf(all.text, "Accept All Cookies") })).error, false);
  const near = await browse(c, b, { action: "select", ref: select, value: "issuer 0" });
  assert.match(near.text, /issuer 0\\" names 10 options of e\d+: \\"Issuer 00 AG\\"/);
  assert.equal((await browse(c, b, { action: "select", ref: select, value: "Example Widgets" })).error, false);
  const untick = await browse(c, b, { action: "click", ref: checkbox });
  assert.equal(untick.error, false, untick.text);
  assert.match(untick.text, /checkbox \\"Current notices only\\" (\[active\] )?\[ref=e\d+\]"/);
  // The year first, then the month, then the day; each part's ref from a fresh observe.
  for (const [part, value] of [["Year", "2025"], ["Month", "9"], ["Day", "2"]]) {
    const found = await browse(c, b, { action: "observe", query: part });
    const typed = await browse(c, b, { action: "type", ref: refOf(found.text, `spinbutton "${part}"`), value });
    assert.equal(typed.error, false, typed.text);
    assert.match(typed.text, new RegExp(`spinbutton \\\\"${part}\\\\" (\\[active\\] )?\\[ref=e\\d+\\]: ${value}"`));
  }
  const searched = await browse(c, b, { action: "click", ref: search });
  assert.equal(searched.error, false, searched.text);
  assert.match(searched.text, /"page_changes": "\d+ lines appeared, \d+ disappeared"/);
  assert.match(searched.text, /row \\"2025-09-03 Example Widgets AG Details\\" \[ref=e\d+\]/);
  assert.match(searched.text, /row \\"2026-09-15 Example Widgets AG Details\\"/);
  assert.doesNotMatch(searched.text, /Issuer 07 AG/);
  assert.doesNotMatch(searched.text, /"text":/);
  const rows = await browse(c, b, { action: "observe", query: "2025-09-03" });
  assert.match(rows.text, /table "Results" \[e\d+\] > row "2025-09-03 Example Widgets AG Details" \[ref=e\d+\]\n {4}link "Details" \[ref=e\d+\] -> http:\/\/register\.exchange\.test\/notices#\/notice\/N1/);
  assert.equal((await browse(c, b, { action: "click", ref: refOf(rows.text, `link "Details"`) })).error, false);
  const detail = await browse(c, b, { action: "observe", query: "own shares" });
  assert.match(detail.text, /region "Notice detail" \[e\d+\] > paragraph \[ref=e\d+\]: Example Widgets AG holds own shares 1,500,000/);
  assert.match((await browse(c, b, { action: "text" })).text, /\[select: Example Widgets AG \(62 options\)\]/);
}));

test("a click that navigates a moment later is followed and reported as a new page; back returns", () => withBrowser(async (c, b) => {
  await browse(c, b, { action: "open", url: `${ISSUER}/investors` });
  const o = await browse(c, b, { action: "observe", query: "late reports" });
  const r = await browse(c, b, { action: "click", ref: refOf(o.text, "Late reports link") });
  assert.equal(r.error, false, r.text);
  assert.match(r.text, /"url": "http:\/\/ir\.issuer\.test\/reports"/);
  assert.match(r.text, /"changed": true/);
  assert.match(r.text, /Report archive/);
  assert.doesNotMatch(r.text, /page_changes/);
  const back = await browse(c, b, { action: "back" });
  assert.match(back.text, /"url": "http:\/\/ir\.issuer\.test\/investors"/);
  assert.match((await browse(c, b, { action: "scroll" })).text, /Issuer results text/);
}));

test("a popup to a public host opens as a new tab and is reported; a JS navigation or a popup to a private host is blocked", () => withBrowser(async (c, b) => {
  await browse(c, b, { action: "open", url: `${ISSUER}/investors` });
  const o = await browse(c, b, { action: "observe" });
  const tab = await browse(c, b, { action: "click", ref: refOf(o.text, "Reports in a new tab") });
  assert.equal(tab.error, false, tab.text);
  assert.match(tab.text, /"switched_to_new_tab": "t2"/);
  assert.match(tab.text, /Report archive/);
  assert.equal((await browse(c, b, { action: "tabs" })).text, `t1 ${ISSUER}/investors\nt2 (current) ${ISSUER}/reports`);
  assert.match((await browse(c, b, { action: "switch_tab", tab: "t1" })).text, /Issuer results text/);
  assert.match((await browse(c, b, { action: "switch_tab", tab: "t9" })).text, /no tab t9/);
  const pop = await browse(c, b, { action: "click", ref: refOf(o.text, "Open viewer") });
  assert.equal(pop.error, false, pop.text);
  assert.match(pop.text, /"closed_new_tab": "a new tab to http:\/\/10\.9\.9\.9\/popup was blocked and closed"/);
  const js = await browse(c, b, { action: "click", ref: refOf(o.text, "Open archive") });
  assert.equal(js.error, false, js.text);
  assert.match(js.text, /navigation to http:\/\/10\.9\.9\.9\/js was blocked \(private_host\); reopened http:\/\/ir\.issuer\.test\/investors/);
  assert.equal((await browse(c, b, { action: "tabs" })).text, `t1 (current) ${ISSUER}/investors\nt2 ${ISSUER}/reports`);
  // A link whose plain-http redirect hop the proxy refuses: the tab goes back too, not to about:blank.
  await browse(c, b, { action: "open", url: `${ISSUER}/reports` });
  const moved = await browse(c, b, { action: "observe", query: "moved report" });
  const hop = await browse(c, b, { action: "click", ref: refOf(moved.text, `link "Download pdf"`) });
  assert.equal(hop.error, false, hop.text);
  assert.match(hop.text, /navigation to http:\/\/10\.9\.9\.9\/stolen\.pdf was blocked \(private_host\); reopened http:\/\/ir\.issuer\.test\/reports/);
  assert.deepEqual(leaked(["10.9.9.9"]), []);
}));

/** Every file under dir, skipping what Chrome deletes while the walk runs. */
function files(dir) {
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return names.flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
}

test("screenshot returns an image in the reply and writes no file", () => withBrowser(async (c, b) => {
  await browse(c, b, { action: "open", url: `${ISSUER}/reports` });
  const images = () => files(root).filter((f) => /\.(png|jpe?g)$/i.test(f));
  const before = images();
  const r = await c.callTool({ name: "browse", arguments: { browser: b, action: "screenshot" } });
  assert.ok(!r.isError, JSON.stringify(r.content));
  assert.equal(r.content[0].type, "image");
  assert.equal(r.content[0].mimeType, "image/png");
  assert.deepEqual([...Buffer.from(r.content[0].data, "base64").subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(r.content[1].text, `${ISSUER}/reports`);
  assert.deepEqual(images(), before);
}));

test("two browsers at once never see each other's tabs, refs or outlines", { timeout: 120_000 }, async () => {
  const c = await client(main.url);
  const [a, b] = [await start(c), await start(c)];
  try {
    await Promise.all([browse(c, a, { action: "open", url: `${ISSUER}/investors` }), browse(c, b, { action: "open", url: `${ISSUER}/reports` })]);
    const [oa, ob] = await Promise.all([browse(c, a, { action: "observe" }), browse(c, b, { action: "observe" })]);
    assert.match(oa.text, /^http:\/\/ir\.issuer\.test\/investors\n/);
    assert.doesNotMatch(oa.text, /Report archive/);
    assert.match(ob.text, /^http:\/\/ir\.issuer\.test\/reports\n/);
    assert.doesNotMatch(ob.text, /Open archive/);
    // A opens the reports page too, in a new tab; B keeps its one tab.
    assert.match((await browse(c, a, { action: "click", ref: refOf(oa.text, "Reports in a new tab") })).text, /"switched_to_new_tab": "t2"/);
    assert.equal((await browse(c, b, { action: "tabs" })).text, `t1 (current) ${ISSUER}/reports`);
    // B's ref acts on B's page only, though A shows the same page.
    const chosen = await browse(c, b, { action: "select", ref: refOf(ob.text, "combobox"), value: "2025" });
    assert.equal(chosen.error, false, chosen.text);
    assert.match((await browse(c, b, { action: "observe" })).text, /combobox \(label "Report archive"\) \[ref=e\d+\]: 2 options, selected "2025"/);
    assert.match((await browse(c, a, { action: "observe" })).text, /combobox \(label "Report archive"\) \[ref=e\d+\]: 2 options, selected "2026"/);
    assert.equal((await browse(c, a, { action: "tabs" })).text, `t1 ${ISSUER}/investors\nt2 (current) ${ISSUER}/reports`);
  } finally {
    await call(c, "close", { browser: a });
    await call(c, "close", { browser: b });
  }
});

const PAGES = [["investors", "Issuer results text"], ["reports", "Report archive"],
  ["presentations", "Full-year results 2025 presentation"], ["date-search", "Disclosure search"]];
let four;

test("four callers at once each read only their own page, and their calls overlap", { timeout: 120_000 }, async () => {
  const cs = await Promise.all(PAGES.map(() => client(main.url)));
  const handles = await Promise.all(cs.map((c) => start(c)));
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
  // A cookie written by a browser that closed cleanly: the crash must not lose what the profile already had.
  const before = await start(c, { profile: "crash" });
  await browse(c, before, { action: "open", url: `${ISSUER}/set-cookie?v=c1` });
  await call(c, "close", { browser: before });
  const h = await start(c, { profile: "crash" });
  await browse(c, h, { action: "open", url: `${ISSUER}/reports` });
  d.proc.kill("SIGKILL");
  await d.exited;
  for (const pid of ownProcesses(d.stateDir, d.profileRoot)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  assert.ok(existsSync(join(d.profileRoot, "crash")));
  assert.ok(lstatSync(join(d.profileRoot, "crash", "SingletonLock"), { throwIfNoEntry: false }), "the crash left Chrome's lock");
  const d2 = await daemon({ BROWSER_PROFILE_ROOT: d.profileRoot }, d.stateDir);
  const c2 = await client(d2.url);
  const h2 = await start(c2, { profile: "crash" });
  const shown = await browse(c2, h2, { action: "open", url: `${ISSUER}/show-cookie` });
  assert.equal(shown.error, false, shown.text);
  assert.match(shown.text, /Cookie: visit=c1/);
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

test("the host map without the fixture proxy, or malformed, is refused at start", async () => {
  const none = await spawnRaw({ BROWSER_MINIMAX_KEY: KEY, BROWSER_TEST_HOSTS: JSON.stringify(TEST_HOSTS) });
  assert.equal(none.code, 1);
  assert.match(none.stderr, /BROWSER_TEST_HOSTS needs BROWSER_TEST_PROXY/);
  assert.doesNotMatch(none.stderr, /listening on/);
  const bad = await spawnRaw({ BROWSER_MINIMAX_KEY: KEY, BROWSER_TEST_PROXY: site.url, BROWSER_TEST_HOSTS: '{"a.test": ["not-an-ip"]}' });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /BROWSER_TEST_HOSTS must be JSON/);
  assert.doesNotMatch(bad.stderr, /listening on/);
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
