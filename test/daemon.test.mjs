// End-to-end tests of the browser daemon over Streamable HTTP MCP, with a local forward proxy that plays the
// internet (an issuer site, a shared document CDN, third parties). Network-free; needs Chrome and Xvfb.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
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

let site;
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
  const port = await freePort();
  const proc = spawn(process.execPath, [DAEMON], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env,
    BROWSER_PORT: String(port), BROWSER_BASE_PROFILE: join(root, "base"), BROWSER_STATE_DIR: stateDir,
    BROWSER_TEST_PROXY: site.url, BROWSER_TEST_CALL_LIMIT_MS: String(LIMIT_MS), ...env } });
  const d = { proc, port, stateDir, url: `http://127.0.0.1:${port}/mcp`,
    exited: new Promise((ok) => proc.once("exit", ok)) };
  daemons.push(d);
  await new Promise((ok, err) => {
    let out = "";
    proc.stderr.on("data", (chunk) => {
      out += chunk;
      process.stderr.write(chunk);
      if (out.includes("listening on")) ok();
    });
    d.exited.then((code) => err(new Error(`daemon exited with ${code}: ${out}`)));
  });
  return d;
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

async function start(c) {
  const r = await call(c, "start", {});
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

/** Processes that belong to a daemon's state directory: Chromes (by their profile path) and Xvfbs (by the pids it logged). */
function ownProcesses(stateDir) {
  const found = [];
  for (const pid of readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
    try {
      if (readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(stateDir)) found.push(Number(pid));
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
  assert.deepEqual(ownProcesses(d.stateDir), []);
});

test("after SIGTERM no Chrome, Xvfb or profile copy is left", { timeout: 120_000 }, async () => {
  const d = await daemon();
  const c = await client(d.url);
  for (const url of [`${ISSUER}/reports`, `${ISSUER}/investors`]) {
    const b = await start(c);
    assert.equal((await browse(c, b, { action: "open", url })).error, false);
  }
  assert.ok(ownProcesses(d.stateDir).length > 0);
  d.proc.kill("SIGTERM");
  await d.exited;
  assert.deepEqual(ownProcesses(d.stateDir), []);
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
  for (const pid of ownProcesses(d.stateDir)) {
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
