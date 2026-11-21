// End-to-end tests of the code console (browser_eval) over Streamable HTTP MCP, with the local forward proxy that
// plays the internet (test/fixture-site.mjs). Network-free; needs Chrome, Xvfb and poppler. The daemon harness is a
// small copy of test/acquire.test.mjs's, with a shorter call limit to see scripts run over it.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { RESULT_CHARS, EXAMPLES, bounded } from "../src/console.mjs";
import { TEST_HOSTS, startFixtureSite } from "./fixture-site.mjs";

const DAEMON = resolve(import.meta.dirname, "../src/daemon.mjs");
const ISSUER = "http://ir.issuer.test";
const LIMIT_MS = 12_000;
const KEY = "console-test-key";

let site;
let root;
let d;
let c;

async function freePort() {
  const probe = createServer();
  await new Promise((ok) => probe.listen(0, "127.0.0.1", ok));
  const { port } = probe.address();
  await new Promise((ok) => probe.close(ok));
  return port;
}

before(async () => {
  site = await startFixtureSite();
  root = mkdtempSync(join(tmpdir(), "browser-mcp-console-"));
  for (const dir of ["base", "state", "named"]) mkdirSync(join(root, dir));
  const port = await freePort();
  const proc = spawn(process.execPath, [DAEMON], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env,
    BROWSER_PORT: String(port), BROWSER_BASE_PROFILE: join(root, "base"), BROWSER_STATE_DIR: join(root, "state"),
    BROWSER_PROFILE_ROOT: join(root, "named"), BROWSER_MINIMAX_KEY: KEY, BROWSER_TEST_PROXY: site.url,
    BROWSER_TEST_HOSTS: JSON.stringify(TEST_HOSTS), BROWSER_TEST_CALL_LIMIT_MS: String(LIMIT_MS) } });
  d = { proc, stateDir: join(root, "state"), exited: new Promise((ok) => proc.once("exit", ok)) };
  await new Promise((ok, err) => {
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
      if (stderr.includes("listening on")) ok();
    });
    d.exited.then((code) => err(new Error(`daemon exited with ${code}: ${stderr}`)));
  });
  c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
});

after(async () => {
  await c?.close();
  d?.proc.kill("SIGTERM");
  await d?.exited;
  site?.server.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

const replies = [];
async function call(name, args) {
  const r = await c.callTool({ name, arguments: args });
  const text = r.content.filter((x) => x.type === "text").map((x) => x.text).join("\n");
  replies.push(text);
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  return { error: !!r.isError, text, data, t1: Date.now() };
}

/** A browser (with a save_dir unless `save: false`), closed after fn whatever happens. */
async function withBrowser(fn, { save = true } = {}) {
  const dir = save ? mkdtempSync(join(root, "save-")) : undefined;
  const r = await call("start", dir ? { save_dir: dir } : {});
  assert.equal(r.error, false, r.text);
  const b = r.data.browser;
  try {
    await fn(b, dir);
  } finally {
    await call("close", { browser: b });
  }
}

const run = (b, code) => call("browser_eval", { browser: b, code });
const open = (b, url) => call("browse", { browser: b, action: "open", url });
const events = (handle) => readFileSync(join(d.stateDir, "logs", `${handle}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const registry = (dir) => readFileSync(join(dir, "sources", "registry.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a script's return value comes back; undefined is null; an unserializable value or a throw fails clearly", () => withBrowser(async (b) => {
  await open(b, `${ISSUER}/reports`);
  const r = await run(b, "return {title: await page.title(), links: await page.getByRole('link').count()}");
  assert.equal(r.error, false, r.text);
  assert.equal(r.data.truncated, false);
  assert.deepEqual(r.data.value, { title: "Reports", links: 5 });
  assert.equal(r.data.browser.url, `${ISSUER}/reports`);
  assert.equal(r.data.browser.tab, "t1");
  assert.equal((await run(b, "const local = 42;")).data.value, null);
  for (const code of ["return 1n", "const a = {}; a.a = a; return a", "return () => 1"]) {
    const bad = await run(b, code);
    assert.equal(bad.error, true, code);
    assert.match(bad.data.error, /return a JSON-serializable value/);
  }
  const thrown = await run(b, "\nthrow new Error('fixture failure')");
  assert.equal(thrown.error, true);
  assert.match(thrown.data.error, /fixture failure \(line 2 of the code\)/);
  assert.equal(thrown.data.browser.url, `${ISSUER}/reports`);
  assert.match((await run(b, "return (")).data.error, /SyntaxError|Unexpected/);
  const log = events(b);
  assert.ok(log.some((e) => e.type === "console_submitted" && e.code === "return 1n"));
  assert.ok(log.some((e) => e.type === "console_error" && /fixture failure/.test(e.error)));
  assert.ok(log.some((e) => e.type === "console_returned" && e.json === "null"));
}));

test("a result over the bound comes back as a stated preview; the audit log has it whole", () => withBrowser(async (b) => {
  await open(b, `${ISSUER}/reports`);
  const r = await run(b, "return 'x'.repeat(30000)");
  assert.equal(r.error, false, r.text);
  assert.equal(r.data.truncated, true);
  assert.equal(r.data.value_chars, 30002);
  assert.ok(JSON.stringify(r.data.value_preview).length - 2 <= RESULT_CHARS);
  assert.equal(r.data.browser.url, `${ISSUER}/reports`);
  assert.ok(events(b).some((e) => e.type === "console_returned" && JSON.parse(e.json).length === 30000));
  const long = await run(b, " ".repeat(32_001));
  assert.equal(long.error, true, "code over its bound is refused");
}));

test("a preview of escaped data stays within the bound", () => {
  for (const value of ["x", '"\\\n\u0000']) {
    const json = JSON.stringify(value.repeat(30000));
    const r = bounded(json);
    assert.equal(r.truncated, true);
    assert.equal(r.value_chars, json.length);
    assert.ok(JSON.stringify(r.value_preview).length - 2 <= RESULT_CHARS);
    assert.ok(JSON.stringify(r.value_preview).length - 2 > RESULT_CHARS - 10);
  }
  assert.deepEqual(bounded('{"a":1}'), { truncated: false, value: { a: 1 } });
});

test("documents and downloads a script causes are saved, with their source_id in the reply, also when it throws", { timeout: 120_000 }, () => withBrowser(async (b, dir) => {
  await open(b, `${ISSUER}/investors`);
  let r = await run(b, "await page.getByRole('link', {name: 'Presentation.pdf', exact: true}).click(); await page.waitForTimeout(1000); return 'clicked'");
  assert.equal(r.error, false, r.text);
  const [deck] = r.data.browser.downloads;
  assert.match(deck.source_id, /^s[0-9a-f]{10}$/);
  const rec = registry(dir).find((x) => x.source_id === deck.source_id);
  assert.equal(rec.via, "new_tab");
  assert.equal(rec.parent_url, `${ISSUER}/investors`);
  assert.equal(rec.link_text, "Presentation.pdf");
  assert.equal(r.data.browser.url, `${ISSUER}/investors`);

  await open(b, `${ISSUER}/reports`);
  r = await run(b, "await page.getByRole('link', {name: 'Download pdf'}).first().click(); return 'followed'");
  assert.equal(r.error, false, r.text);
  const report = registry(dir).find((x) => x.source_id === r.data.browser.downloads[0].source_id);
  assert.equal(report.via, "console_navigation");
  assert.equal(report.final_url, "http://cdn.shared.test/space1/ar-2025.pdf");
  assert.equal(report.parent_url, `${ISSUER}/reports`);
  assert.match(report.link_context, /2025 Annual Report \(published 3 March 2026\)/);
  assert.equal(r.data.browser.url, `${ISSUER}/reports`, "the tab went back to its page");

  r = await run(b, "await page.getByRole('link', {name: 'Quarterly results', exact: true}).click(); throw new Error('after download')");
  assert.equal(r.error, true);
  assert.match(r.data.error, /after download/);
  assert.match(r.data.browser.downloads[0].source_id, /^s[0-9a-f]{10}$/);
  assert.equal(registry(dir).find((x) => x.source_id === r.data.browser.downloads[0].source_id).via, "download");

  // After the console attached, and after its child died, a browse click's download is still saved.
  const browseDownload = async () => {
    const o = await call("browse", { browser: b, action: "observe", query: "Quarterly" });
    const ref = /\[ref=(e\d+)\]/.exec(o.text.split("\n").find((l) => l.includes('link "Quarterly results"')))[1];
    const atomic = await call("browse", { browser: b, action: "click", ref });
    assert.equal(atomic.error, false, atomic.text);
    assert.match(atomic.data.downloads[0].source_id, /^s[0-9a-f]{10}$/);
  };
  await browseDownload();
  assert.equal((await run(b, "process.exit(3)")).error, true);
  await browseDownload();
}));

test("a script over its limit is stopped, its browser killed and restarted; the handle works after; another browser is not held up", { timeout: 180_000 }, async () => {
  await withBrowser((other) => withBrowser(async (b) => {
    await open(other, `${ISSUER}/reports`);
    for (const code of ["while (true) {}", `await page.waitForTimeout(60000); await page.goto('${ISSUER}/should-not-run')`,
      "await page.evaluate(() => { while (true) {} })"]) {
      await open(b, `${ISSUER}/reports`);
      const pid = events(b).filter((e) => e.type === "browser_started").at(-1).chrome_pid;
      const started = Date.now();
      const [hang, read] = await Promise.all([run(b, code), call("browse", { browser: other, action: "text" })]);
      assert.equal(hang.error, true, code);
      assert.match(hang.data.error, /ran over its 12 s limit and was stopped; your code and its browser were killed, and the browser restarts on the next call/);
      assert.ok(Date.now() - started < LIMIT_MS + 8_000, code);
      assert.equal(alive(pid), false, "the browser was killed before the reply");
      assert.equal(read.error, false, read.text);
      assert.match(read.text, /Report archive/);
      assert.ok(read.t1 < hang.t1, "the other browser was not held up");
      const next = await run(b, `await page.goto('${ISSUER}/presentations'); return page.url()`);
      assert.equal(next.error, false, next.text);
      assert.equal(next.data.value, `${ISSUER}/presentations`);
      assert.match((await call("browse", { browser: b, action: "text" })).text, /Presentations/);
    }
    assert.ok(!site.hits.includes("ir.issuer.test/should-not-run"));
    assert.equal(events(b).filter((e) => e.type === "browser_reset").length, 3);
  }));
});

test("two consoles at once each see only their own browser's pages", { timeout: 120_000 }, () => withBrowser((a) => withBrowser(async (b) => {
  await open(a, `${ISSUER}/reports`);
  await open(b, `${ISSUER}/presentations`);
  const code = "await page.waitForTimeout(500); return context.pages().map((p) => p.url())";
  const [ra, rb] = await Promise.all([run(a, code), run(b, code)]);
  assert.deepEqual(ra.data.value, [`${ISSUER}/reports`]);
  assert.deepEqual(rb.data.value, [`${ISSUER}/presentations`]);
}), { save: false }));

test("snapshot refuses a page off the policy; a script's navigation and its page's request to a private host are blocked", () => withBrowser(async (b) => {
  await open(b, `${ISSUER}/reports`);
  const outline = await run(b, "return await snapshot()");
  assert.match(outline.data.value, /heading "Reports"/);
  const go = await run(b, "try { await page.goto('http://inside.test/console') } catch (e) { return String(e.message) } return 'reached'");
  assert.equal(go.error, false, go.text);
  assert.notEqual(go.data.value, "reached");
  assert.match(go.data.browser.blocked, /navigation to http:\/\/inside\.test\/console was blocked \(resolves_private\)/);
  const snap = await run(b, "return await snapshot()");
  assert.equal(snap.error, true);
  assert.match(snap.data.error, /snapshot refused chrome-error:\/\/chromewebdata\/ \(scheme\)/);
  await open(b, `${ISSUER}/reports`);
  const literal = await run(b, "try { await page.goto('http://127.0.0.1:9/') } catch (e) { return 'refused' } return 'reached'");
  assert.equal(literal.data.value, "refused");
  await open(b, `${ISSUER}/reports`);
  const fetched = await run(b, "return await page.evaluate(() => fetch('http://10.9.9.9/console').then(() => 'reached', () => 'refused'))");
  assert.equal(fetched.data.value, "refused");
  assert.ok(!site.hits.some((h) => h.startsWith("10.9.9.9") || h.startsWith("inside.test")));
  const log = events(b);
  assert.ok(log.some((e) => e.type === "rejected" && e.url === "http://inside.test/console"));
  assert.ok(log.some((e) => e.type === "rejected" && e.url === "http://10.9.9.9/console"));
}, { save: false }));

test("caller code runs in a child process: not the daemon, without its key or endpoint; an exit ends only the child", { timeout: 120_000 }, () => withBrowser(async (b) => {
  await open(b, `${ISSUER}/reports`);
  const who = await run(b, "return {pid: process.pid, key: process.env.BROWSER_MINIMAX_KEY ?? null}");
  assert.equal(who.error, false, who.text);
  assert.notEqual(who.data.value.pid, d.proc.pid);
  assert.equal(who.data.value.key, null);
  const exit = await run(b, "process.exit(3)");
  assert.equal(exit.error, true);
  assert.match(exit.data.error, /the console's process ended \(code 3\); the next call starts a new one/);
  assert.equal(alive(who.data.value.pid), false);
  const again = await run(b, "return {pid: process.pid, url: page.url()}");
  assert.equal(again.error, false, again.text);
  assert.notEqual(again.data.value.pid, who.data.value.pid);
  assert.equal(again.data.value.url, `${ISSUER}/reports`);
  // A page's own script can call the link capture's binding: what it sends does not end the daemon.
  const forged = await run(b, "await page.evaluate(() => { __browserLinkClicked('not json'); __browserLinkClicked('[1]'); }); return 'sent'");
  assert.equal(forged.error, false, forged.text);
  assert.equal((await call("browse", { browser: b, action: "text" })).error, false);
  assert.equal(events(b).filter((e) => e.type === "link_capture_error").length, 2);
  const [port] = readFileSync(join(d.stateDir, "profiles", b, "DevToolsActivePort"), "utf8").split("\n");
  assert.ok(!replies.some((t) => t.includes(`:${port}`) || t.includes(KEY)), "no reply holds the endpoint or the key");
}, { save: false }));

test("every example in the description runs on a fixture page", { timeout: 120_000 }, () => withBrowser(async (b) => {
  const pages = [`${ISSUER}/date-search`, `${ISSUER}/reports`, `${ISSUER}/date-search`, `${ISSUER}/date-search`, `${ISSUER}/investors`];
  for (const [i, example] of EXAMPLES.entries()) {
    await open(b, pages[i]);
    const r = await run(b, example.code);
    assert.equal(r.error, false, `${example.name}: ${r.text}`);
    const value = JSON.stringify(r.data.value);
    if (i === 0) assert.match(value, /Disclosure search/);
    if (i === 1) assert.match(value, /Quarterly results/);
    if (i === 2) assert.match(value, /Registered shares/);
    if (i === 3) {
      assert.deepEqual(r.data.value.from, ["2024", "01", "01"]);
      assert.match(r.data.value.outline, /No matching notices/);
    }
    if (i === 4) assert.match(r.data.browser.downloads[0].source_id, /^s[0-9a-f]{10}$/);
  }
}));

test("the daemon's state keeps no download of a closed browser", () => {
  assert.deepEqual(readdirSync(join(d.stateDir, "downloads")), []);
});
