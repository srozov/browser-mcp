// The browse actions on one browser entry: the page helpers and actions moved from the page readers' browser
// server. They take the entry `b` (see browsers.mjs) instead of module state, so a browser's tabs, refs and
// outline are its own. The refusal at the top of `open` is moved from the readers' server, with the
// resolved-address check added; so is the one before a click on a link. The page model is snapshot.mjs (moved).
// A styled checkbox is ticked through its own label only, never through an overlay (new). A document a click opens
// in a new tab, or downloads, is saved by code (acquire.mjs), as the readers' after-action step did; the console
// (console.mjs) shares that step for the tabs its scripts open.

import { errors } from "patchright";
import { saveTabDocument } from "./acquire.mjs";
import { policyLookup, rejected } from "./browsers.mjs";
import { isDocumentType, refuse, reject } from "./policy.mjs";
import { diff, outline, paged, parse, query, subtree, target } from "./snapshot.mjs";

export const NAV_TIMEOUT_MS = 60_000;
const TEXT_PAGE = 6000;
const CHANGE_CHARS = 1500; // lines that appeared, shown in an in-place action's reply

/** The current tab, brought to the front: a background tab in a headed browser does not render. */
export async function page(b) {
  const p = b.tabs.get(b.current);
  if (!p) throw new Error("no open tab; use browse with action open");
  if (b.front !== p) {
    await p.bringToFront();
    b.front = p;
  }
  return p;
}

function tabId(b, p) {
  for (const [id, x] of b.tabs) if (x === p) return id;
  return null;
}

export async function settle(p) {
  try {
    await p.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS });
    await p.waitForLoadState("networkidle", { timeout: 5000 });
  } catch {}
  await p.waitForTimeout(800);
}

export async function visibleText(p) {
  // A select shows as its chosen option and its size, not every option: a long option list filled the
  // first text page. observe lists and searches its options.
  return p.evaluate(() => {
    let text = (document.querySelector("main") || document.body)?.innerText || "";
    for (const s of document.querySelectorAll("select")) {
      const all = (s.innerText || "").trim();
      if (all) text = text.replace(all, `[select: ${s.selectedOptions[0]?.label.trim() ?? ""} (${s.options.length} options)]`);
    }
    return text;
  });
}

const isPublicPage = (url) => reject(url) === null;

/**
 * The tab's URL. Playwright's can lag behind the document when a refused navigation raced the way back: it still
 * says chrome-error while the tab shows the page it went back to. Then the document's own location decides.
 */
async function currentUrl(p) {
  const url = p.url();
  if (isPublicPage(url)) return url;
  return p.evaluate(() => location.href).catch(() => url);
}

/** Content leaves the browser only from a public http(s) page; anything else is closed and logged. */
export async function checkedPage(b, p) {
  const url = await currentUrl(p);
  // A fresh tab, or one sent back after a document: say so, not "ended on about:blank" (agents called
  // text with a url and read that as a blocked page).
  if (url === "about:blank") throw new Error("no page is open in this tab: use browse open {url} first");
  if (isPublicPage(url)) {
    b.lastGood.set(p, url);
    return url;
  }
  const reason = reject(url);
  rejected(b, "final_url", url, reason);
  await p.goto("about:blank").catch(() => {});
  throw new Error(`the page ended on ${url} (${reason}); nothing from it is returned`);
}

/**
 * A blocked navigation leaves Chrome on its error page, or, for a plain-http redirect hop, on the proxy's
 * refusal shown at the refused URL (the proxy served nothing from it): go back to the page it came from, so
 * the agent keeps its place, and say what was blocked. Anything else that is not a public page fails.
 */
async function recover(b, p) {
  const url = await currentUrl(p);
  if (isPublicPage(url)) return null;
  const blocked = url.startsWith("chrome-error:") ? b.refusedNavigation : /^https?:/i.test(url) ? { url, reason: reject(url) } : null;
  const previous = b.lastGood.get(p);
  if (blocked && previous) {
    await p.goto(previous, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => {});
    await settle(p);
    if (isPublicPage(p.url())) return `navigation to ${blocked.url} was blocked (${blocked.reason}); reopened ${p.url()}`;
  }
  await checkedPage(b, p);
  return null;
}

async function summary(b, p, extra = {}) {
  const note = await recover(b, p);
  if (note) extra = { blocked: note, ...extra };
  const url = await checkedPage(b, p);
  const text = (await visibleText(p)).replace(/\n{3,}/g, "\n\n");
  return {
    tab: tabId(b, p),
    url,
    title: await p.title(),
    text: text.slice(0, 2500),
    text_chars: text.length,
    ...extra,
    hint: "observe shows the page's outline with refs (e12); text reads the page in pages",
  };
}

export const blockedText = (url, refusal) => `${url} is blocked (${refusal.reason}${refusal.address ? ` ${refusal.address}` : ""})`;

/**
 * Open a URL in the tab. A URL that downloads is saved; one that serves a document is not a page: the tab goes back
 * to the page it was on, so the agent keeps its place, and the call says to acquire it.
 */
export async function open(b, url) {
  // `refuse` lets a page's inline data: and blob: requests through; `open` takes http(s) only, as the readers' did.
  const scheme = reject(url);
  const refusal = scheme ? { reason: scheme } : await refuse(url, policyLookup());
  if (refusal) {
    rejected(b, "open", url, refusal.reason, refusal.address);
    throw new Error(blockedText(url, refusal));
  }
  const p = await page(b);
  const earlier = b.downloads.length; // an earlier click's late download is the call's to report, not this URL's
  // Chrome's PDF viewer never reaches domcontentloaded: a document is recognised by its response headers.
  const document = p.waitForResponse((r) => r.request().isNavigationRequest() && r.frame() === p.mainFrame() &&
    isDocumentType(r.headers()["content-type"]), { timeout: NAV_TIMEOUT_MS }).catch(() => null);
  let download = false;
  let blocked = null;
  // Each redirect hop is a request of its own: the navigation's last one is the hop that failed.
  let hop = url;
  const onRequest = (req) => {
    if (req.isNavigationRequest() && req.frame() === p.mainFrame()) hop = req.url();
  };
  p.on("request", onRequest);
  const refusals = b.refusals = [];
  let response;
  try {
    response = await Promise.race([document, p.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch((e) => {
      if (String(e).includes("Download is starting")) {
        download = true;
        return null;
      }
      // An https hop the proxy refused fails the navigation as a tunnel failure: say what it refused, by the hop's
      // host:port (the proxy's CONNECT authority), not by the latest refusal, which may be Chrome's own connection.
      if (String(e).includes("ERR_TUNNEL_CONNECTION_FAILED")) {
        const { hostname, port } = new URL(hop);
        const refused = refusals.findLast((r) => r.via === "connection" && r.url === `${hostname}:${port || 443}`);
        if (refused) {
          blocked = blockedText(refused.url, refused);
          return null;
        }
      }
      throw e;
    })]);
  } finally {
    p.off("request", onRequest);
    b.refusals = null;
  }
  // A plain-http hop the proxy refused is its 403, marked with the reason.
  const policy = response?.headers()["x-source-policy"];
  if (policy) blocked = `${response.url()} is blocked (${policy})`;
  if (blocked) {
    const previous = b.lastGood.get(p);
    await p.goto(previous ?? "about:blank", { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => {});
    throw new Error(`${blocked}${previous ? `; the tab is back on ${previous}` : ""}`);
  }
  if (download) return { downloads: await Promise.all(b.downloads.splice(earlier)), note: "the URL was a download, not a page" };
  if (response && isDocumentType(response.headers()["content-type"])) {
    const previous = b.lastGood.get(p);
    await p.goto(previous ?? "about:blank", { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => {});
    throw new Error(`${url} is a document, not a page: save it with acquire {url}${previous ? `; the tab is back on ${previous}` : ""}`);
  }
  await settle(p);
  return summary(b, p);
}

export async function text(b, n = 1) {
  const p = await page(b);
  const url = await checkedPage(b, p);
  const body = await visibleText(p);
  return `${url} text page ${n} of ${Math.max(1, Math.ceil(body.length / TEXT_PAGE))}\n${body.slice((n - 1) * TEXT_PAGE, n * TEXT_PAGE)}`;
}

/** The current page's ARIA snapshot, parsed. Its refs (e12) address elements while the page holds them. */
async function model(b, p) {
  const url = await checkedPage(b, p);
  const { full } = await p._snapshotForAI({ timeout: 20_000 });
  return { url, root: parse(full, url) };
}

function checkRef(ref) {
  if (!/^(?:f\d+)?e\d+$/.test(ref)) throw new Error(`"${ref}" is not a ref: refs look like e12 and come from observe; observe again`);
}

const stale = (ref) => new Error(`ref ${ref} is not on the page now (it changed or reloaded); observe again`);

/** An element of the current tab by its ref, looked up in a fresh snapshot (refs stay while the element does). */
export async function element(b, ref) {
  checkRef(ref);
  const p = await page(b);
  const { url, root } = await model(b, p);
  const info = target(root, ref);
  if (!info) throw stale(ref);
  return { p, url, root, info, locator: p.locator(`aria-ref=${ref}`) };
}

export async function observe(b, { query: q, ref, page: n }) {
  if (q && ref) throw new Error("observe takes a query or a ref, not both");
  // The outline is cut, not paged: a page without a query or a ref would return the same outline as page 1.
  if (n && !q && !ref) throw new Error("observe takes page only with a query or a ref; the outline is one view");
  const { url, root } = await model(b, await page(b));
  const opts = { blocked: reject };
  if (ref) {
    checkRef(ref);
    const r = subtree(root, ref, opts);
    if (!r) throw stale(ref);
    const pg = paged(r.lines, n);
    return `${url}\nref ${ref}${r.path ? ` in ${r.path}` : ""}, page ${pg.page} of ${pg.pages}\n${pg.text}`;
  }
  if (q) {
    const r = query(root, q, opts);
    if (!r.hits) return `${url}\nnothing on the page matches "${q}"; observe without a query shows the outline`;
    const pg = paged(r.lines, n);
    const head = r.partial ? `no line has all ${r.words} words of "${q}"; ${r.hits} lines have ${r.best} of them`
      : `${r.hits} lines match "${q}"`;
    return `${url}\n${head}, page ${pg.page} of ${pg.pages}\n${pg.text}`;
  }
  return `${url}\noutline (observe {query} finds lines; observe {ref} shows one part whole)\n${outline(root, opts)}`;
}

/** Run a pointer action; when another element covers its target, say so in one line (a cookie banner
 * swallowed every click, and the agent got Playwright's whole retry log). */
async function covered(action) {
  try {
    return await action();
  } catch (error) {
    const line = String(error.message).split("\n").find((l) => l.includes("intercepts pointer events"));
    if (!line) throw error;
    // "<div class="x"></div> from <div id="y">…</div> subtree intercepts pointer events": name y, else x.
    const m = / from <[a-z]+[^>]*\bid="([^"]+)"/.exec(line) || /<[a-z]+[^>]*\b(?:id|class)="([^" ]+)/.exec(line);
    const by = m ? m[1] : "an overlay";
    throw new Error(`another element (${by}) covers it, often a cookie or consent banner: observe the banner's ` +
      `buttons (e.g. query "cookie" or "accept"), click one, then retry`);
  }
}

/** Tick or untick. A styled checkbox hides its input under its own label, which takes the click: then the
 * click goes where the input is, as a person's would, and lands on that label. Anything else covering the
 * input (a banner) is never clicked through: the click's own error is reported. */
async function toggle(p, locator) {
  try {
    await locator.click({ timeout: 3000 });
  } catch (error) {
    if (!(error instanceof errors.TimeoutError)) throw error;
    const box = await locator.boundingBox();
    const at = box && [box.x + box.width / 2, box.y + box.height / 2];
    const ownLabel = at && await locator.evaluate((el, [x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return !!hit && [...(el.labels ?? [])].some((label) => label.contains(hit));
    }, at);
    if (!ownLabel) return covered(() => {
      throw error;
    });
    await p.mouse.click(...at);
  }
}

/** The option a select value names: its exact label, else the one option whose label contains it. */
function option(ref, info, value) {
  if (!info.options) throw new Error(`ref ${ref} is a ${info.role}, not a select: click it instead`);
  if (!info.options.length) throw new Error(`ref ${ref} lists no options: click it to open it, then click the option`);
  if (info.options.includes(value)) return value;
  const near = info.options.filter((o) => o.toLowerCase().includes(value.toLowerCase()));
  if (near.length === 1) return near[0];
  const listed = near.slice(0, 10).map((o) => JSON.stringify(o)).join(", ");
  throw new Error(near.length ? `"${value}" names ${near.length} options of ${ref}: ${listed}${near.length > 10 ? ", …" : ""}; give one label`
    : `no option of ${ref} contains "${value}"; observe with a query to find its label`);
}

/**
 * A navigation or new tab an action may start, listened for before the action: a link click often
 * navigates or opens a tab a moment after the click returns, and settling at once read the old page as
 * "changed in place".
 */
function navigation(b, p) {
  b.refusedNavigation = null; // a refusal before the action is not what the action ran into
  return Promise.race([
    p.waitForEvent("framenavigated", { predicate: (f) => f === p.mainFrame(), timeout: 1500 }),
    b.context.waitForEvent("page", { timeout: 1500 }),
  ]).catch(() => null);
}

/**
 * The tabs an action opened: a public page becomes the current tab; a blocked one is closed; a document one is saved
 * by code, with the clicked link's text and context (and its page, when the console captured it), and closed.
 */
export async function newTabs(b, p, info) {
  const extra = {};
  for (const id of b.opened.splice(0)) {
    const tab = b.tabs.get(id);
    if (!tab) continue;
    // Chrome's PDF viewer never reaches domcontentloaded: stop waiting once the tab shows a document.
    for (let i = 0; i < 50 && !b.documents.has(tab); i++) {
      if (await tab.waitForLoadState("domcontentloaded", { timeout: 200 }).then(() => true, () => false)) break;
    }
    // A popup's first response can come before its tab event: then the tab says what it shows.
    const shows = b.documents.has(tab) ? null : await Promise.race([tab.evaluate(() => document.contentType),
      new Promise((ok) => setTimeout(ok, 2000, ""))]).catch(() => "");
    const doc = b.documents.get(tab) ?? (isDocumentType(shows) ? tab.url() : null);
    if (doc && isPublicPage(doc)) {
      const opener = await tab.opener().catch(() => null) ?? p;
      b.downloads.push(saveTabDocument(b, doc, { parent_url: info.parent_url ?? opener.url(), link_text: info.name ?? null, link_context: info.context ?? null }));
      await tab.close().catch(() => {});
      continue;
    }
    await settle(tab);
    if (isPublicPage(tab.url())) {
      b.current = id;
      extra.switched_to_new_tab = id;
    } else {
      // A popup the guard refused shows Chrome's error page: name what it was refused.
      const refused = tab.url().startsWith("chrome-error:") ? b.refusedNavigation : null;
      const url = refused?.url ?? tab.url();
      rejected(b, "new_tab", url, refused?.reason ?? reject(url) ?? "blocked");
      extra.closed_new_tab = `a new tab to ${url} was blocked and closed`;
      await tab.close().catch(() => {});
    }
  }
  return extra;
}

/** After a click, select or type: new tabs and downloads, then the new page, or the lines that changed in place. */
async function afterAction(b, p, before, moved, rootBefore, info = {}) {
  await moved;
  if (!p.isClosed()) await settle(p);
  const extra = await newTabs(b, p, info);
  const done = await Promise.all(b.downloads.splice(0));
  if (done.length) extra.downloads = done;
  const active = await page(b);
  const changed = active !== p || active.url() !== before;
  if (changed) return summary(b, active, { ...extra, changed });
  // In place (a filter set, a box ticked): return only the lines that changed.
  const note = await recover(b, active);
  const { url, root } = await model(b, active);
  const d = diff(rootBefore, root, { blocked: reject });
  const appeared = [];
  for (const l of d.added) {
    if (appeared.join("\n").length + l.length > CHANGE_CHARS) break;
    appeared.push(l);
  }
  return { tab: tabId(b, active), url, changed, ...(note ? { blocked: note } : {}), ...extra,
    page_changes: `${d.added.length} lines appeared, ${d.removed} disappeared`
      + (appeared.length < d.added.length ? `; the first ${appeared.length} below, observe for the rest` : ""),
    appeared };
}

export async function click(b, ref) {
  const { p, root, info, locator } = await element(b, ref);
  // A link to a refused address is not clicked; a javascript: link has no address to check.
  if (info.url && /^https?:/i.test(info.url)) {
    const refusal = await refuse(info.url, policyLookup());
    if (refusal) {
      rejected(b, "click", info.url, refusal.reason, refusal.address);
      throw new Error(blockedText(info.url, refusal));
    }
  }
  const before = p.url();
  const moved = navigation(b, p);
  if (["checkbox", "radio", "switch"].includes(info.role)) await toggle(p, locator);
  else await covered(() => locator.click({ timeout: 10_000 }));
  return afterAction(b, p, before, moved, root, info);
}

export async function select(b, ref, value) {
  const { p, root, info, locator } = await element(b, ref);
  const label = option(ref, info, value);
  const before = p.url();
  const moved = navigation(b, p);
  await covered(() => locator.selectOption({ label }, { timeout: 10_000 }));
  return afterAction(b, p, before, moved, root);
}

export async function typeInto(b, ref, value, submit) {
  const { p, root, info, locator } = await element(b, ref);
  const before = p.url();
  const moved = navigation(b, p);
  if (info.role === "spinbutton") {
    // A date picker's part re-renders on each key: type as a person does.
    await covered(() => locator.click({ timeout: 10_000 }));
    await p.keyboard.press("ControlOrMeta+a"); // replace the part's value, not append to it
    await p.keyboard.type(value, { delay: 50 });
  } else {
    await covered(() => locator.fill(value, { timeout: 10_000 }));
  }
  if (submit) await p.keyboard.press("Enter");
  return afterAction(b, p, before, moved, root);
}

export async function back(b) {
  const p = await page(b);
  await p.goBack({ timeout: NAV_TIMEOUT_MS });
  await settle(p);
  return summary(b, p);
}

export async function scroll(b) {
  const p = await page(b);
  await p.mouse.wheel(0, 2500);
  await settle(p);
  return summary(b, p);
}

export function tabs(b) {
  return [...b.tabs].map(([id, p]) => `${id}${id === b.current ? " (current)" : ""} ${p.url()}`).join("\n");
}

export async function switchTab(b, id) {
  if (!b.tabs.has(id)) throw new Error(`no tab ${id}: tabs lists this browser's tabs`);
  b.current = id;
  return summary(b, await page(b));
}

/** An image of the current view, returned in the reply: it is never written to disk. */
export async function screenshot(b) {
  const p = await page(b);
  const url = await checkedPage(b, p);
  const image = await p.screenshot();
  return { content: [{ type: "image", data: image.toString("base64"), mimeType: "image/png" }, { type: "text", text: url }] };
}
