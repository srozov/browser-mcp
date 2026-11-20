// `open` and `text` on one browser entry: the page helpers moved from the page readers' browser server.
// They take the entry `b` (see browsers.mjs) instead of module state. The refusal at the top of `open` is moved
// from the readers' server, with the resolved-address check added. The outline, saving documents and the
// console arrive with later tickets.

import { policyLookup, rejected } from "./browsers.mjs";
import { isDocumentType, refuse } from "./policy.mjs";

const NAV_TIMEOUT_MS = 60_000;
const TEXT_PAGE = 6000;

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

async function settle(p) {
  try {
    await p.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS });
    await p.waitForLoadState("networkidle", { timeout: 5000 });
  } catch {}
  await p.waitForTimeout(800);
}

async function visibleText(p) {
  // A select shows as its chosen option and its size, not every option: a long option list filled the
  // first text page.
  return p.evaluate(() => {
    let text = (document.querySelector("main") || document.body)?.innerText || "";
    for (const s of document.querySelectorAll("select")) {
      const all = (s.innerText || "").trim();
      if (all) text = text.replace(all, `[select: ${s.selectedOptions[0]?.label.trim() ?? ""} (${s.options.length} options)]`);
    }
    return text;
  });
}

function checkedPage(b, p) {
  const url = p.url();
  // A fresh tab, or one sent back after a document: say so, not "ended on about:blank" (agents called
  // text with a url and read that as a blocked page).
  if (url === "about:blank") throw new Error("no page is open in this tab: use browse open {url} first");
  b.lastGood.set(p, url);
  return url;
}

async function summary(b, p) {
  const url = checkedPage(b, p);
  const text = (await visibleText(p)).replace(/\n{3,}/g, "\n\n");
  return {
    url,
    title: await p.title(),
    text: text.slice(0, 2500),
    text_chars: text.length,
    hint: "text reads the page in pages",
  };
}

/**
 * Open a URL in the tab. One that serves a document is not a page: the tab goes back to the page it
 * was on, so the agent keeps its place.
 */
export async function open(b, url) {
  const refusal = await refuse(url, policyLookup());
  if (refusal) {
    rejected(b, "open", url, refusal.reason, refusal.address);
    throw new Error(`${url} is blocked (${refusal.reason}${refusal.address ? ` ${refusal.address}` : ""})`);
  }
  const p = await page(b);
  const started = Date.now();
  // Chrome's PDF viewer never reaches domcontentloaded: a document is recognised by its response headers.
  const document = p.waitForResponse((r) => r.request().isNavigationRequest() && r.frame() === p.mainFrame() &&
    isDocumentType(r.headers()["content-type"]), { timeout: NAV_TIMEOUT_MS }).catch(() => null);
  let download = false;
  const response = await Promise.race([document, p.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch((e) => {
    if (String(e).includes("Download is starting")) {
      download = true;
      return null;
    }
    // A refused https hop or a refused WebSocket-less tunnel fails the navigation: say what the proxy refused.
    const refused = b.lastRefusal;
    if (String(e).includes("ERR_TUNNEL_CONNECTION_FAILED") && refused && refused.at >= started) {
      throw new Error(`${refused.url} is blocked (${refused.reason}${refused.address ? ` ${refused.address}` : ""})`);
    }
    throw e;
  })]);
  const policy = response?.headers()["x-source-policy"];
  if (policy) {
    const previous = b.lastGood.get(p);
    await p.goto(previous ?? "about:blank", { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => {});
    throw new Error(`${response.url()} is blocked (${policy})${previous ? `; the tab is back on ${previous}` : ""}`);
  }
  if (download || (response && isDocumentType(response.headers()["content-type"]))) {
    const previous = b.lastGood.get(p);
    await p.goto(previous ?? "about:blank", { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => {});
    throw new Error(`${url} is a document, not a page: documents are not read yet${previous ? `; the tab is back on ${previous}` : ""}`);
  }
  await settle(p);
  return summary(b, p);
}

export async function text(b, n = 1) {
  const p = await page(b);
  const url = checkedPage(b, p);
  const body = await visibleText(p);
  return `${url} text page ${n} of ${Math.max(1, Math.ceil(body.length / TEXT_PAGE))}\n${body.slice((n - 1) * TEXT_PAGE, n * TEXT_PAGE)}`;
}
