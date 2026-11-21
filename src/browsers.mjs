// The browser table: one headed Chrome per handle, each with its own Xvfb display, its own copy of the base
// profile, its own tabs and its own call queue. The launch, reset, cleanup, time limit and audit log are
// moved from the page readers' browser server, where they were the state of one process; here they are
// fields of an entry. So are the request guard and the rejection log (moved), the policy proxy (new,
// proxy.mjs) and the downloads a page starts (moved; acquire.mjs saves them). Calls with different handles share
// nothing: no module-level browser state.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, cpSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "patchright";
import { saveDownload } from "./acquire.mjs";
import { isDocumentType, refuse, systemLookup } from "./policy.mjs";
import { profilePath } from "./profiles.mjs";
import { startProxy } from "./proxy.mjs";

const MAX_BROWSERS = 4;
const IDLE_MS = 10 * 60_000;
const CALL_LIMIT_MS = 120_000;
// A full-page image of a very long page can outrun this; the page is saved without it.
const SCREENSHOT_MS = 30_000;
const LOG_KEEP_MS = 30 * 24 * 3_600_000;
// The close of the browser resetBrowser last dropped: its Chrome holds the profile's lock until it exits, and a launch
// on a locked profile fails at once. A launch waits for it, at most RETIRE_MS.
const RETIRE_MS = 15_000;

const table = new Map(); // handle -> entry
const closing = new Set(); // entries out of the table whose Xvfb and clone are not gone yet
let config = null;

const now = () => new Date().toISOString();

/** Called once by the daemon. Clones and old logs left by a dead daemon are deleted here. */
/** `proxy` is the fixture proxy of the offline tests: the policy proxy's upstream. `lookup` resolves names for the policy. */
export function configure({ baseProfile, profileRoot, stateDir, proxy, lookup, callLimitMs, idleMs, screenshotMs }) {
  config = { baseProfile, profileRoot, profiles: join(stateDir, "profiles"), logs: join(stateDir, "logs"), upstream: proxy, lookup: lookup ?? systemLookup,
    callLimitMs: callLimitMs ?? CALL_LIMIT_MS, idleMs: idleMs ?? IDLE_MS, screenshotMs: screenshotMs ?? SCREENSHOT_MS };
  // Every clone belongs to a dead daemon (one daemon per state directory). Its Chrome and Xvfb are
  // killed by systemd's control-group kill, not here.
  rmSync(config.profiles, { recursive: true, force: true });
  mkdirSync(config.profiles, { recursive: true });
  mkdirSync(config.logs, { recursive: true });
  for (const name of readdirSync(config.logs)) {
    const file = join(config.logs, name);
    if (name.endsWith(".jsonl") && Date.now() - statSync(file).mtimeMs > LOG_KEEP_MS) rmSync(file);
  }
  setInterval(() => {
    for (const b of [...table.values()]) {
      if (b.busy === 0 && Date.now() - b.lastUsed > config.idleMs) {
        close(b.handle, "idle").catch((error) => process.stderr.write(`browser-mcp: closing idle ${b.handle} failed: ${error.message}\n`));
      }
    }
  }, Math.min(config.idleMs / 2, 60_000)).unref();
}

export function log(b, event) {
  appendFileSync(b.log, JSON.stringify({ ts: now(), browser: b.handle, ...event }) + "\n");
}

/** The lookup the source policy uses, for `open`. */
export const policyLookup = () => config.lookup;

/** The time a saved page's image may take, for acquire. */
export const screenshotLimit = () => config.screenshotMs;

/** A refused request, in the browser's own log; `open` reads `lastRefusal` to say what a redirect hop hit. */
export function rejected(b, via, url, reason, address) {
  log(b, { type: "rejected", via, url, reason, ...(address ? { address } : {}) });
  b.lastRefusal = { via, url, reason, address, at: Date.now() };
}

/** The request guard: the early refusal for a page's requests, with how each was made. Redirect hops and sockets are the proxy's. */
function guard(b) {
  return async (route, req) => {
    const refusal = await refuse(req.url(), config.lookup);
    if (!refusal) return route.continue().catch(closed);
    let via = req.resourceType();
    try {
      if (req.isNavigationRequest()) via = req.frame().parentFrame() === null ? "navigation" : "frame";
    } catch {
      // A request without a frame (a worker, or a popup's first navigation) is logged by its resource type.
      if (req.isNavigationRequest()) via = "navigation";
    }
    // What a tab left on Chrome's error page was refused; lastRefusal also holds Chrome's own connections.
    if (via === "navigation") b.refusedNavigation = { url: req.url(), reason: refusal.reason };
    rejected(b, via, req.url(), refusal.reason, refusal.address);
    return route.abort("blockedbyclient").catch(closed);
  };
}

// A page that closed under a pending request: nothing to continue or abort.
const closed = (error) => {
  if (!/Target (page, context or browser )?(has been )?closed|Target closed/i.test(String(error?.message))) throw error;
};

/** One audit line for a browser-free call (a search): no handle, so one file per UTC day. */
export function searchLog(event) {
  const ts = now();
  appendFileSync(join(config.logs, `search-${ts.slice(0, 10)}.jsonl`), JSON.stringify({ ts, ...event }) + "\n");
}

/**
 * A browser of one's own: a handle and, without a name, a copy of the base profile; with one, the named profile
 * itself. A named browser holds its profile while it is in the table or in `closing`: there is no lock file.
 * `saveDir` (checked by the daemon) is where acquire saves. Chrome launches on the first call.
 */
export function start({ profile: name, saveDir = null } = {}) {
  const named = name === undefined ? null : profilePath(config.profileRoot, name);
  if (named) {
    // Never the full handle: a second caller must not get a working handle to another caller's browser.
    const holder = [...table.values()].find((b) => b.named === name);
    if (holder) {
      throw new Error(`profile "${name}" is in use by browser ${holder.handle.slice(0, 6)}…: one browser per profile; ` +
        `it is freed when that browser is closed or after ${config.idleMs / 60_000} idle minutes`);
    }
    // Out of the table, but its Chrome still holds Chrome's own lock until close() is done.
    const ending = [...closing].find((b) => b.named === name);
    if (ending) throw new Error(`profile "${name}" is being closed with browser ${ending.handle.slice(0, 6)}…: start again in a moment`);
  }
  if (table.size >= MAX_BROWSERS) {
    throw new Error(`${table.size} browsers are running, at the cap of ${MAX_BROWSERS}: close one first`);
  }
  const handle = randomBytes(12).toString("base64url");
  const profile = named ?? join(config.profiles, handle);
  if (!named) cpSync(config.baseProfile, profile, { recursive: true, filter: (src) => !/^Singleton/.test(src.split("/").pop()) });
  const b = { handle, profile, named: named ? name : null, saveDir, downloads: [], log: join(config.logs, `${handle}.jsonl`), xvfb: null, proxy: null, lastRefusal: null, context: null, starting: null,
    retiring: Promise.resolve(), tabs: new Map(), current: null, front: null, tabCount: 0, lastGood: new WeakMap(), opened: [], documents: new WeakMap(), refusedNavigation: null,
    queue: Promise.resolve(), lastUsed: Date.now(), busy: 0, closed: false };
  table.set(handle, b);
  log(b, { type: "registered", ...(b.named ? { profile: b.named } : {}) });
  return handle;
}

export function get(handle) {
  const b = table.get(handle);
  if (!b) {
    throw new Error(`unknown browser "${handle}": it was closed, closed after ${config.idleMs / 60_000} idle minutes, ` +
      "or the daemon restarted; call start for a new one");
  }
  return b;
}

async function startXvfb() {
  const proc = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", "1280x1024x24", "-nolisten", "tcp"], {
    stdio: ["ignore", "ignore", "ignore", "pipe"],
  });
  const display = await new Promise((ok, err) => {
    let out = "";
    proc.stdio[3].on("data", (chunk) => {
      out += chunk;
      if (out.includes("\n")) ok(out.trim());
    });
    proc.once("exit", (code) => err(new Error(`Xvfb exited with ${code}`)));
    setTimeout(() => err(new Error("Xvfb did not report a display")), 15_000);
  });
  return { proc, display: `:${display}` };
}

function addTab(b, page) {
  const id = `t${++b.tabCount}`;
  b.tabs.set(id, page);
  page.on("close", () => b.tabs.delete(id));
  // Saved by code; the action that caused it, or the next call, reports it.
  page.on("download", (download) => {
    log(b, { type: "download_started", url: download.url(), tab: id });
    b.downloads.push(saveDownload(b, download, page.url()));
  });
  // The document a tab's main frame shows (Chrome's PDF viewer): the after-action step closes such a new tab.
  page.on("response", (r) => {
    if (r.frame() === page.mainFrame() && r.request().isNavigationRequest()) {
      if (isDocumentType(r.headers()["content-type"])) b.documents.set(page, r.url());
      else b.documents.delete(page);
    }
  });
  return id;
}

const gone = (b) => {
  if (b.closed) throw new Error("the browser was closed during startup");
};

export async function ensureBrowser(b) {
  if (b.starting) return b.starting;
  if (b.context) return;
  b.starting = (async () => {
    await Promise.race([b.retiring, new Promise((ok) => setTimeout(ok, RETIRE_MS).unref())]);
    gone(b);
    if (!b.xvfb) {
      const xvfb = await startXvfb();
      if (b.closed) xvfb.proc.kill("SIGTERM");
      gone(b);
      b.xvfb = xvfb;
    }
    if (!b.proxy) {
      const proxy = await startProxy({ lookup: config.lookup, upstream: config.upstream,
        onRefused: ({ url, reason, address }) => rejected(b, "connection", url, reason, address) });
      if (b.closed) await proxy.close();
      gone(b);
      b.proxy = proxy;
    }
    const context = await chromium.launchPersistentContext(b.profile, {
      headless: false,
      channel: "chrome",
      env: { ...process.env, DISPLAY: b.xvfb.display },
      viewport: { width: 1280, height: 1000 },
      serviceWorkers: "block",
      acceptDownloads: true,
      // Upstream Playwright disables the back-forward cache and patchright does not: a page restored from it
      // never fires its load events again, so back would wait out its time limit.
      args: ["--no-first-run", "--disable-session-crashed-bubble", "--password-store=basic",
        "--disable-background-networking", "--disable-component-update", "--disable-back-forward-cache",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
      proxy: { server: `http://127.0.0.1:${b.proxy.port}` },
    });
    if (b.closed) {
      await context.close().catch(() => {});
      gone(b);
    }
    b.context = context;
    await context.route("**/*", guard(b));
    // A new tab stays pending until the action that opened it has checked where it went.
    context.on("page", (page) => {
      const id = addTab(b, page);
      b.opened.push(id);
      log(b, { type: "tab_opened", tab: id });
    });
    for (const page of context.pages()) b.current = addTab(b, page);
    if (!b.current) b.current = addTab(b, await context.newPage());
    log(b, { type: "browser_started", display: b.xvfb.display, xvfb_pid: b.xvfb.proc.pid, proxy_port: b.proxy.port, profile: b.profile });
  })().finally(() => {
    b.starting = null;
  });
  return b.starting;
}

/**
 * Drop a browser stuck in a call that ran over its limit; the next call starts a fresh one on the same profile.
 * The policy proxy is kept: it belongs to the entry, not to one Chrome.
 */
export function resetBrowser(b, reason) {
  const old = b.context;
  b.context = null;
  b.tabs.clear();
  b.opened.length = 0;
  b.current = null;
  b.front = null;
  log(b, { type: "browser_reset", reason });
  b.retiring = Promise.allSettled([old?.close()]);
}

/** One call at a time per browser; other browsers' calls do not wait for it. */
export function run(b, fn) {
  const result = b.queue.then(async () => {
    b.busy++;
    b.lastUsed = Date.now();
    try {
      return await fn();
    } finally {
      b.busy--;
      b.lastUsed = Date.now();
    }
  });
  b.queue = result.catch(() => {});
  return result;
}

export class CallTimeout extends Error {}

/** Run fn within the call's time limit; past it the call fails. */
export function limited(name, fn, onTimeout, limit = config.callLimitMs) {
  let timer;
  const over = new Promise((_, err) => {
    timer = setTimeout(() => {
      onTimeout?.();
      err(new CallTimeout(`${name} ran over its ${limit / 1000} s limit and was stopped`));
    }, limit);
  });
  // A throw from fn itself becomes a rejection: otherwise the timer would outlive the call and reject unhandled.
  return Promise.race([new Promise((ok) => ok(fn())), over]).finally(() => clearTimeout(timer));
}

/** Delete the handle at once, so later calls get "unknown browser"; then end its Chrome and Xvfb and delete its clone. */
export async function close(handle, reason) {
  const b = get(handle);
  table.delete(handle);
  closing.add(b);
  b.closed = true;
  // A launch in flight ends its own Chrome once it sees `closed`; the clone is deleted only after, so Chrome
  // does not write a fresh profile into a deleted directory. A named profile is never deleted. The hold on it
  // (`closing`) ends on every path, a throw included.
  try {
    await Promise.allSettled([b.starting]);
    try {
      await b.context?.close();
    } catch {}
    b.xvfb?.proc.kill("SIGTERM");
    await b.proxy?.close();
    await Promise.race([b.retiring, new Promise((ok) => setTimeout(ok, RETIRE_MS).unref())]);
    if (!b.named) rmSync(b.profile, { recursive: true, force: true, maxRetries: 3 });
  } finally {
    closing.delete(b);
  }
  log(b, { type: "closed", reason });
}

export function closeAll(reason) {
  return Promise.allSettled([...table.keys()].map((handle) => close(handle, reason)));
}

/**
 * For the process's exit hook, whatever path ends it: no await, no Chrome of its own is waited for. It covers
 * the entries a close is still ending too: on SIGINT the process exits while closeAll is under way. The policy
 * proxies are listeners of this process and end with it.
 */
export function exitSync() {
  for (const b of [...table.values(), ...closing]) {
    b.xvfb?.proc.kill("SIGTERM");
    if (!b.named) rmSync(b.profile, { recursive: true, force: true, maxRetries: 3 });
  }
}
