// The code console (browser_eval): caller code against its own browser's current tab, run by a child process per
// browser (console-child.mjs) connected to that browser alone, never in the daemon. Moved from the page readers'
// evaluator: the code and result bounds, the bounded result, one call at a time, the link capture, the reconciling
// after a call (shared with browse, browse.mjs) and the kill on a timeout. New: a child process where they had a
// worker thread, and the value bounded apart from the browser part of the reply, so a preview never cuts a source_id.

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { saveTabDocument } from "./acquire.mjs";
import { log } from "./browsers.mjs";
import { NAV_TIMEOUT_MS, checkedPage, newTabs, page, settle } from "./browse.mjs";
import { reject } from "./policy.mjs";

export const RESULT_CHARS = 12_000;
export const CODE_CHARS = 32_000;
const ERROR_CHARS = 2_000;
const KILL_WAIT_MS = 5_000;
const CHILD = fileURLToPath(new URL("./console-child.mjs", import.meta.url));

// Executable documentation. The labels are invented: inspect the real page before choosing locators.
export const EXAMPLES = [
  { name: "Inspect the current page", code: "return {url: page.url(), outline: await snapshot()};" },
  { name: "Find a bounded list of report links", code: `return await page.locator('a').evaluateAll(links => links
  .map(a => ({text: a.innerText, url: a.href}))
  .filter(a => /report|annual|interim|results/i.test(a.text)).slice(0, 8));` },
  { name: "Read table text in the page's DOM context", code: `return await page.evaluate(() => Array.from(document.querySelectorAll('table'))
  .slice(0, 2).map(table => table.innerText.slice(0, 2000)));` },
  { name: "Set a date shown in parts and submit", code: `const from = page.getByRole('group', {name: 'From', exact: true});
await from.getByRole('spinbutton', {name: 'Year', exact: true}).fill('2024');
await from.getByRole('spinbutton', {name: 'Month', exact: true}).fill('01');
await from.getByRole('spinbutton', {name: 'Day', exact: true}).fill('01');
await page.getByRole('button', {name: 'Search', exact: true}).click();
return {from: await from.locator('input').evaluateAll(xs => xs.map(x => x.value)), outline: await snapshot()};` },
  { name: "Open a document link", code: `await page.getByRole('link', {name: 'Presentation.pdf', exact: true}).click();
return 'clicked: browser.downloads gives the saved document\\'s source_id';` },
];

export const DESCRIPTION = (limitMs) => `Run Playwright JavaScript in your own browser (the one start gave you), as the body of an async
function. In scope: page (your browser's current tab), context (its BrowserContext) and snapshot(page?) (the page's
accessibility outline, as browse observe shows it). Use plain JS control flow, Playwright locators, navigation and
page.evaluate. Return a JSON-serializable value; no return gives null. Await every action; leave no timers or
background work. Tabs, cookies and page state persist across calls and with browse and acquire; a call's variables do not.
Browser only (a prompt fence, not a sandbox): no filesystem, imports, process, shell, environment, context.request or
any network client of your own; reach the web only through the browser, whose source policy applies to every
request. No model is called here. Your code, its result and its errors go to the browser's audit log.
Limit ${limitMs / 1000} s, saving included: a call over it stops your code, and your browser is killed and restarted before
the reply (cookies stay, tabs are gone): open a page again. Code at most ${CODE_CHARS} characters.
The reply is {truncated: false, value, browser}: value is your return, up to ${RESULT_CHARS} characters of JSON. Over that it is
{truncated: true, value_chars, value_preview}, a preview only: return less and run again. browser holds the current
tab and its URL, tab changes (switched_to_new_tab, closed_new_tab, tabs_closed) and downloads: the documents and
downloads your actions caused, saved by code, each with its source_id (not_saved without a save_dir). A failed
script's error reply carries browser too: check it for sources.
Use it for awkward controls, for inspecting links or the DOM, or for a short sequence of understood actions. Look at the
page first (browse observe, or snapshot()), choose unique, scoped locators from the labels you saw, await actions in
order, then check the resulting state before the next batch. document and window exist only inside page.evaluate or a
locator's evaluate callback, not in your function. Never force a click through an overlay: dismiss it.
A date shown in parts can be set in one script, the year first, then the month, then the day; return the parts' values
to confirm them.
A returned value is not citable evidence: save a web page with acquire {current_page: true}. A PDF or download your
script opened is saved for you, its source_id in browser.downloads; read that source before citing it.
Examples (invented labels: adapt them only after inspecting the page):
${EXAMPLES.map((e) => `${e.name}:\n${e.code}`).join("\n\n")}`;

/** The return value as it goes into the reply: whole up to RESULT_CHARS characters of JSON, else a stated preview. */
export function bounded(json) {
  if (json.length <= RESULT_CHARS) return { truncated: false, value: JSON.parse(json) };
  // The preview is JSON inside JSON: its escaped quotes and control characters count too.
  let low = 0;
  let high = Math.min(RESULT_CHARS, json.length);
  while (low < high) {
    const n = Math.ceil((low + high) / 2);
    if (JSON.stringify(json.slice(0, n)).length - 2 <= RESULT_CHARS) low = n;
    else high = n - 1;
  }
  return { truncated: true, value_chars: json.length, value_preview: json.slice(0, low) };
}

/** Browser b's child, connected to its current endpoint. Its calls run one at a time; a dead child fails the call. */
function startConsole(b) {
  // The child runs caller code: none of the daemon's settings (the search key) reach it.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("BROWSER_")));
  const child = fork(CHILD, [], { env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  // Console output is audit material, never protocol output.
  for (const stream of ["stdout", "stderr"]) child[stream].on("data", (data) => log(b, { type: "console_output", stream, text: String(data) }));
  let pending = null;
  let failure = null;
  let stopped = false;
  let restored = Promise.resolve();
  let ok;
  let refused;
  const ready = new Promise((resolve, reject_) => {
    ok = resolve;
    refused = reject_;
  });
  ready.catch(() => {});
  const fail = (error) => {
    failure ??= error;
    refused(failure);
    pending?.reject(failure);
    pending = null;
  };
  child.on("message", (m) => {
    if (m.ready) return ok();
    // Its error names the endpoint: the audit log gets it, the reply does not.
    if (m.failed) {
      log(b, { type: "console_error", error: m.failed });
      return fail(new Error("the console could not connect to this browser"));
    }
    const call = pending;
    pending = null;
    if (m.error !== undefined) {
      const error = new Error(m.error);
      error.detail = m.stack;
      call?.reject(error);
    } else call?.resolve(m.result);
  });
  child.on("error", fail);
  child.on("exit", (code, signal) => {
    fail(new Error(`the console's process ended (${signal ?? `code ${code}`}); the next call starts a new one`));
    // Its CDP connection set Chrome's download behaviour, and ending it put Chrome's default back: a download would go
    // to the user's own download directory and never finish here. Unless the daemon stopped it with its browser, set
    // the daemon's back.
    if (!stopped) restored = b.cdp?.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: b.downloadsPath, eventsEnabled: true })
      .catch((error) => log(b, { type: "console_error", error: `the download behaviour was not set back: ${error.message}` }));
  });
  child.send({ endpoint: b.endpoint, downloadsPath: b.downloadsPath });
  return {
    ready,
    get failed() {
      return failure !== null;
    },
    get restored() {
      return restored;
    },
    run(call) {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject_) => {
        pending = { resolve, reject: reject_ };
        child.send(call);
      });
    },
    stop: () => {
      stopped = true;
      child.kill("SIGKILL");
    },
  };
}

/** For a call over its limit, before the reply: the child and Chrome are killed, so no script acts on after it. */
export async function killBrowser(b) {
  b.console?.stop();
  b.console = null;
  if (b.pid) {
    try {
      process.kill(b.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  await Promise.race([b.context?.close().catch(() => {}), new Promise((ok) => setTimeout(ok, KILL_WAIT_MS).unref())]);
}

/** The CDP target id of a tab: the child finds the same tab by it. */
async function targetOf(b, p) {
  const session = await b.context.newCDPSession(p);
  const { targetInfo } = await session.send("Target.getTargetInfo");
  await session.detach();
  return targetInfo.targetId;
}

/**
 * After a script, whether it returned or threw: the tabs it opened (newTabs), a document it opened in the current tab
 * (saved by code; the tab goes back), its downloads, and the tabs it closed. Returns the reply's browser part.
 */
async function reconcile(b, p, before, tabsBefore) {
  const link = b.links.get(p);
  if (!p.isClosed()) await settle(p);
  const extra = await newTabs(b, p, { name: link?.link_text, context: link?.link_context, parent_url: link?.parent_url });
  const doc = p.isClosed() ? null : b.documents.get(p);
  if (doc && !reject(doc)) {
    b.downloads.push(saveTabDocument(b, doc, { parent_url: link?.parent_url ?? before, link_text: link?.link_text ?? null,
      link_context: link?.link_context ?? null, via: "console_navigation" }));
    await p.goto(b.lastGood.get(p) ?? "about:blank", { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => {});
  }
  const done = await Promise.all(b.downloads.splice(0));
  if (done.length) extra.downloads = done;
  const closed = [...tabsBefore].filter((id) => !b.tabs.has(id));
  if (closed.length) extra.tabs_closed = closed;
  if (!b.tabs.has(b.current)) {
    // The script closed the current tab: the newest one left takes over, or a new blank one.
    b.current = [...b.tabs.keys()].at(-1) ?? null;
    if (!b.current) {
      await b.context.newPage();
      b.current = b.opened.pop();
    }
    extra.switched_to_tab = b.current;
  }
  const url = b.tabs.get(b.current).url();
  const refused = url.startsWith("chrome-error:") ? b.refusedNavigation : null;
  return { tab: b.current, url, ...(refused ? { blocked: `navigation to ${refused.url} was blocked (${refused.reason})` } : {}), ...extra };
}

/** The browser_eval tool on browser b: the code runs in b's child; the reply bounds its value. */
export async function evaluate(b, code, callState) {
  log(b, { type: "console_submitted", code });
  const p = await page(b);
  await b.linkCapture.get(p)?.catch(() => {}); // logged where it failed; the call runs without it
  const before = p.url();
  if (!reject(before)) await checkedPage(b, p);
  const tabsBefore = new Set(b.tabs.keys());
  b.links.delete(p); // a click before this call is not this call's
  b.refusedNavigation = null;
  if (!b.console || b.console.failed) b.console = startConsole(b);
  const running = b.console;
  let json;
  let failure = null;
  try {
    await running.ready;
    json = await running.run({ targetId: await targetOf(b, p), code });
    log(b, { type: "console_returned", json });
  } catch (error) {
    failure = error;
    log(b, { type: "console_error", error: error.detail ?? error.message });
  }
  // Over the limit, the daemon kills this browser: nothing here may act on it, or on the one that replaces it.
  if (callState.cancelled) throw new Error("the console call was stopped");
  await running.restored; // a child that died: the downloads its script caused finish only after this
  const browser = await reconcile(b, p, before, tabsBefore);
  if (failure) {
    const error = new Error(failure.message.slice(0, ERROR_CHARS));
    error.browser = browser;
    throw error;
  }
  return { content: [{ type: "text", text: JSON.stringify({ ...bounded(json), browser }) }] };
}

/** Records the link a click is on before its navigation replaces the page: a document it opens keeps its provenance. */
function captureLinkClicks() {
  document.addEventListener("click", (event) => {
    const a = event.target.closest?.("a[href]");
    const container = a?.closest("li, tr, p, article") || a?.parentElement;
    globalThis.__browserLinkClicked(JSON.stringify(a ? { parent_url: location.href, url: a.href,
      link_text: a.innerText, link_context: container?.innerText || a.innerText } : null));
  }, true);
}

/**
 * Installs the link capture on a tab, through CDP: patchright's addInitScript makes a synthetic navigation that the
 * source policy blocks.
 */
export async function installLinkCapture(b, p) {
  const session = await b.context.newCDPSession(p);
  session.on("Runtime.bindingCalled", ({ name, payload }) => {
    if (name !== "__browserLinkClicked") return;
    const link = JSON.parse(payload);
    if (link) b.links.set(p, link);
    else b.links.delete(p);
  });
  await session.send("Runtime.enable");
  await session.send("Page.enable");
  await session.send("Runtime.addBinding", { name: "__browserLinkClicked" });
  await session.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${captureLinkClicks.toString()})()` });
  await p.evaluate(captureLinkClicks);
}
