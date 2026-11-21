// Saving a page or document with its provenance into the caller's save_dir: code-chosen paths, immutable bytes,
// content-addressed source ids, an append-only registry. Moved from the page readers' browser server (its
// acquisition section), where the sources went to the run's directory; here they go to `<save_dir>/sources/` of the
// browser that saves them, and the daemon keeps none. New: each source is assembled in a staging directory and
// renamed into place before it is registered, and the saves into one save_dir run one at a time, so browsers that
// share a save_dir never collide. The page and sheet texts are pages.mjs's.

import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { policyLookup, rejected, screenshotLimit } from "./browsers.mjs";
import { NAV_TIMEOUT_MS, blockedText, checkedPage, element, open, page, settle, visibleText } from "./browse.mjs";
import { preparePdf, sheets } from "./pages.mjs";
import { isDocumentType, normalize, refuse, reject } from "./policy.mjs";

const FETCH_TIMEOUT_MS = 300_000;
// No full-page image above this height: the bitmap of a 410,000 px page took Chrome past 4 GB, and the OOM kill
// took the server down with it.
const PAGE_IMAGE_MAX_PX = 40_000;

export const NO_SAVE_DIR = "nothing can be saved: this browser was started without save_dir; start a browser with save_dir " +
  "(an absolute, existing directory) to save";

const now = () => new Date().toISOString();
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const isPublicPage = (url) => reject(url) === null;
const isHtml = (mime) => /^\s*(text\/html|application\/xhtml\+xml)/i.test(mime);

/** `<save_dir>/sources`, made on the first save; without a save_dir nothing is saved. */
function sourcesOf(b) {
  if (!b.saveDir) throw new Error(NO_SAVE_DIR);
  const dir = join(b.saveDir, "sources");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// One chain of saves per save_dir (its real path): the check for an existing source, its writes and its registry line
// never interleave with another browser's save into the same save_dir.
const chains = new Map();
function inSaveDir(dir, fn) {
  const result = (chains.get(dir) ?? Promise.resolve()).then(fn);
  const tail = result.catch(() => {});
  chains.set(dir, tail);
  tail.then(() => {
    if (chains.get(dir) === tail) chains.delete(dir);
  });
  return result;
}

/** Fill a fresh staging directory, then move it to `dir`: a failed or cut-off save leaves no half source. */
async function assemble(sources, dir, fill) {
  const staging = join(sources, ".staging", `${dir.split("/").pop()}-${randomBytes(4).toString("hex")}`);
  mkdirSync(staging, { recursive: true });
  try {
    const result = await fill(staging);
    renameSync(staging, dir);
    return result;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function register(sources, record) {
  appendFileSync(join(sources, "registry.jsonl"), JSON.stringify(record) + "\n");
}

function firstRecord(sources, id) {
  return readFileSync(join(sources, "registry.jsonl"), "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line)).find((r) => r.source_id === id && r.event === "acquired");
}

function extension(mime, url, filename) {
  const type = (mime || "").split(";")[0].trim().toLowerCase();
  if (type === "application/pdf") return "pdf";
  if (type.includes("spreadsheetml")) return "xlsx";
  if (type === "application/vnd.ms-excel") return "xls";
  if (type === "text/csv") return "csv";
  if (isHtml(type)) return "html";
  const m = new URL(url).pathname.match(/\.(pdf|xlsx|xls|csv)$/i) ?? filename?.match(/\.(pdf|xlsx|xls|csv)$/i);
  return m ? m[1].toLowerCase() : null;
}

/** The reply: the source id, its files by absolute path, its provenance and the publication evidence. */
function brief(b, record) {
  const out = { source_id: record.source_id, kind: record.kind, title: record.title || null, pages: record.pages ?? null,
    final_url: record.final_url, parent_url: record.parent_url || null,
    files: Object.fromEntries(Object.entries(record.files).map(([kind, path]) => [kind, join(b.saveDir, path)])),
    publication_evidence: { http_last_modified: record.http_last_modified || null, pdf_created: record.pdf_created || null,
      pdf_modified: record.pdf_modified || null, link_context: record.link_context || null } };
  if (record.event === "acquired_again") out.note = "already acquired; same bytes and source id";
  return out;
}

/** Save a document's bytes once under a content-derived id; a repeat only appends a registry event. */
async function store(b, bytes, meta) {
  const sources = sourcesOf(b);
  const digest = sha256(bytes);
  const id = `s${digest.slice(0, 10)}`;
  const ext = extension(meta.mime, meta.final_url, meta.filename);
  if (!ext || ext === "html") throw new Error(`not a document (${meta.mime || "unknown type"}); open web pages with browse and acquire them with current_page`);
  // A "PDF" that is not one (Chrome's viewer page, an error page served as application/pdf) is never stored. The
  // header may follow some junk: PDF readers accept it within the first 1024 bytes, and so here.
  if (ext === "pdf" && !bytes.subarray(0, 1024).toString("latin1").includes("%PDF-")) {
    throw new Error(`${meta.final_url} was served as a PDF but is not one (it starts ${JSON.stringify(bytes.subarray(0, 40).toString("latin1"))})`);
  }
  return inSaveDir(b.saveDir, async () => {
    const dir = join(sources, id);
    const record = { source_id: id, event: existsSync(dir) ? "acquired_again" : "acquired", kind: ext, sha256: digest,
      bytes: bytes.length, retrieved_at: now(), ...meta, files: { original: `sources/${id}/original.${ext}` } };
    if (record.event === "acquired") {
      await assemble(sources, dir, async (staging) => {
        const file = join(staging, `original.${ext}`);
        writeFileSync(file, bytes, { flag: "wx" });
        if (ext === "pdf") {
          const info = await preparePdf(file, staging);
          Object.assign(record, { title: info.title, pages: info.pages, pdf_created: info.created, pdf_modified: info.modified });
          record.files.pages = `sources/${id}/pages/NNNN.txt and NNNN.png (PDF page index, 4 digits)`;
        } else if (ext === "xlsx") {
          const info = sheets(file, staging);
          Object.assign(record, { pages: info.pages, sheets: info.sheets });
          record.files.pages = `sources/${id}/pages/NNNN.txt (one per sheet in workbook order, 4 digits; cite the sheet's number as page)`;
        }
      });
    } else {
      const first = firstRecord(sources, id);
      for (const key of ["title", "pages", "sheets", "pdf_created", "pdf_modified"]) if (first?.[key] !== undefined) record[key] = first[key];
      if (first?.files) record.files = first.files;
    }
    register(sources, record);
    return brief(b, record);
  });
}

/** Save the open web page as a source; `how` carries the provenance of a page acquired by URL or link. */
async function savePage(b, p, how = {}) {
  const sources = sourcesOf(b);
  const url = await checkedPage(b, p);
  const html = await p.content();
  const text = await visibleText(p);
  // A page whose content is in a frame (an inline document viewer) has no text to quote: store nothing and name
  // the frames, whose documents can be acquired themselves.
  if (!text.trim()) {
    const frames = p.frames().slice(1).map((f) => f.url()).filter(isPublicPage);
    throw new Error(`${url} has no text of its own; nothing was saved. ` + (frames.length
      ? `Its content is in frames: ${frames.join(", ")}: acquire one of those`
      : "It may still be loading: observe it, then acquire again"));
  }
  const title = await p.title();
  const digest = sha256(Buffer.from(html));
  const id = `h${digest.slice(0, 10)}`;
  return inSaveDir(b.saveDir, async () => {
    const dir = join(sources, id);
    const files = { original: `sources/${id}/original.html`, text: `sources/${id}/text.txt`, image: `sources/${id}/page.png` };
    const event = existsSync(dir) ? "acquired_again" : "acquired";
    let imageError = null;
    if (event === "acquired") {
      // A failed image must not leave the saved text unregistered: the page is saved and registered without it.
      await assemble(sources, dir, async (staging) => {
        writeFileSync(join(staging, "original.html"), html, { flag: "wx" });
        writeFileSync(join(staging, "text.txt"), text, { flag: "wx" });
        const height = await p.evaluate(() => document.documentElement.scrollHeight);
        if (height > PAGE_IMAGE_MAX_PX) {
          imageError = `the page is ${height} px tall, over the ${PAGE_IMAGE_MAX_PX} px image limit`;
          return;
        }
        try {
          await p.screenshot({ path: join(staging, "page.png"), fullPage: true, timeout: screenshotLimit() });
        } catch (error) {
          rmSync(join(staging, "page.png"), { force: true });
          imageError = String(error.message || error).split("\n")[0];
        }
      });
    }
    if (!existsSync(join(dir, "page.png"))) delete files.image;
    const record = { source_id: id, event, kind: "html", sha256: digest, bytes: html.length, retrieved_at: now(),
      requested_url: url, final_url: url, redirects: [], mime: "text/html", title, parent_url: null, files,
      ...(imageError ? { image_error: imageError } : {}), ...how };
    register(sources, record);
    return { ...brief(b, record), hint: files.image ? "cite text.txt quotes; page.png is the rendered page"
      : "cite text.txt quotes; no page image was saved (the page was too tall or too slow to render)" };
  });
}

/**
 * Fetch a URL with the browser's request client, one redirect hop at a time, each hop checked by the source policy
 * before it is requested. A document is stored; a web page is opened in the tab and saved as a page.
 */
async function fetchUrl(b, url, meta) {
  const hops = [];
  let target = url;
  for (let hop = 0; hop <= 5; hop++) {
    const response = await b.context.request.get(target, { maxRedirects: 0, timeout: FETCH_TIMEOUT_MS, failOnStatusCode: false });
    try {
      const status = response.status();
      if ([301, 302, 303, 307, 308].includes(status)) {
        const next = new URL(response.headers().location || "", target).href;
        hops.push({ from: target, to: next, status });
        const scheme = reject(next);
        const refusal = scheme ? { reason: scheme } : await refuse(next, policyLookup());
        if (refusal) {
          rejected(b, "redirect", next, refusal.reason, refusal.address);
          throw new Error(`redirect to ${blockedText(next, refusal)}`);
        }
        target = next;
        continue;
      }
      // Some sites refuse a scripted client (403) but serve the browser: fetch it as a page would.
      if (status === 403) return await fetchInBrowser(b, target, { ...meta, requested_url: url, redirects: hops });
      if (status !== 200) throw new Error(`HTTP ${status} for ${target}`);
      const mime = response.headers()["content-type"] || "";
      // An HTML release or report is a source too: the browser opens and saves it.
      if (isHtml(mime)) {
        await open(b, target);
        return await savePage(b, await page(b), { requested_url: url, redirects: hops, parent_url: meta.parent_url,
          link_text: meta.link_text, link_context: meta.link_context, via: meta.via });
      }
      if (!isDocumentType(mime)) throw new Error(`${target} is ${mime || "an unknown type"}, neither a document nor a web page`);
      return await store(b, await response.body(), { ...meta, requested_url: url, final_url: target, redirects: hops, mime,
        http_last_modified: response.headers()["last-modified"] || null });
    } finally {
      await response.dispose().catch(() => {});
    }
  }
  throw new Error("too many redirects");
}

/**
 * Fetch a URL the request client was refused through the browser's own navigation: a web page is saved as a page;
 * a document is stored from the tab, and the tab goes back.
 */
async function fetchInBrowser(b, url, meta) {
  const p = await page(b);
  const previous = b.lastGood.get(p);
  const navigated = p.waitForResponse((r) => r.request().isNavigationRequest() && r.frame() === p.mainFrame(),
    { timeout: NAV_TIMEOUT_MS }).catch(() => null);
  // An earlier click's late download is the call's to report, not this URL's.
  const earlier = b.downloads.length;
  let download = false;
  await p.goto(url, { waitUntil: "commit", timeout: NAV_TIMEOUT_MS }).catch((e) => {
    if (!String(e).includes("Download is starting")) throw e;
    download = true;
  });
  const done = download ? await Promise.all(b.downloads.splice(earlier)) : [];
  if (done.length) return done[0];
  const response = await navigated;
  if (!response) throw new Error(`${url} gave no response in the browser either`);
  if (response.status() !== 200) throw new Error(`HTTP ${response.status()} for ${url} (also in the browser)`);
  const mime = response.headers()["content-type"] || "";
  const how = { requested_url: meta.requested_url, redirects: meta.redirects, parent_url: meta.parent_url,
    link_text: meta.link_text, link_context: meta.link_context, via: `${meta.via}+browser` };
  if (isHtml(mime)) {
    await settle(p);
    return savePage(b, p, how);
  }
  if (!isDocumentType(mime)) throw new Error(`${url} is ${mime || "an unknown type"}, neither a document nor a web page`);
  // The navigation's body is Chrome's PDF viewer, not the file: fetch the file from the tab itself (same origin, the
  // browser's own client).
  const base64 = await p.evaluate(async (u) => {
    const r = await fetch(u, { credentials: "include" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const all = new Uint8Array(await r.arrayBuffer());
    let s = "";
    for (let i = 0; i < all.length; i += 0x8000) s += String.fromCharCode(...all.subarray(i, i + 0x8000));
    return btoa(s);
  }, response.url());
  await p.goto(previous ?? "about:blank", { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => {});
  return store(b, Buffer.from(base64, "base64"), { ...how, final_url: response.url(), mime,
    http_last_modified: response.headers()["last-modified"] || null });
}

/** A download a page started, saved by code; resolves to what happened to it, never rejects. */
export async function saveDownload(b, download, pageUrl) {
  const url = download.url();
  try {
    const inline = /^(blob|data):/.test(url) && isPublicPage(pageUrl);
    const reason = reject(url);
    if (reason && !inline) {
      rejected(b, "download", url, reason);
      await download.cancel().catch(() => {});
      return { rejected: url, reason };
    }
    if (!b.saveDir) {
      await download.cancel().catch(() => {});
      return { not_saved: url, reason: NO_SAVE_DIR };
    }
    // Playwright's own copy, deleted once read: the daemon keeps none.
    const bytes = readFileSync(await download.path());
    await download.delete().catch(() => {});
    const filename = download.suggestedFilename();
    const mime = bytes.subarray(0, 1024).toString("latin1").includes("%PDF-") ? "application/pdf" : "";
    return await store(b, bytes, { requested_url: url, final_url: url, redirects: [], mime, filename, parent_url: pageUrl,
      link_text: filename, link_context: null, via: "download" });
  } catch (error) {
    return { failed: url, error: String(error.message || error) };
  }
}

/** A document a new tab showed, fetched and saved by code; resolves to what happened to it, never rejects. */
export async function saveTabDocument(b, url, meta) {
  if (!b.saveDir) return { not_saved: url, reason: NO_SAVE_DIR };
  try {
    return await fetchUrl(b, url, { ...meta, via: "new_tab" });
  } catch (error) {
    return { failed: url, error: String(error.message || error) };
  }
}

async function checked(b, url) {
  const scheme = reject(url);
  const refusal = scheme ? { reason: scheme } : await refuse(url, policyLookup());
  if (refusal) {
    rejected(b, "acquire", url, refusal.reason, refusal.address);
    throw new Error(blockedText(url, refusal));
  }
  return normalize(url);
}

/** The acquire tool: one of url, ref (an observed link) or current_page. */
export async function acquire(b, args) {
  const given = ["url", "ref", "current_page"].filter((k) => args[k]);
  if (given.length > 1) throw new Error(`acquire takes one of url, ref or current_page, not ${given.join(" and ")}`);
  if (!given.length) throw new Error("acquire needs url, ref or current_page");
  sourcesOf(b);
  if (args.current_page) return savePage(b, await page(b));
  if (args.url) return fetchUrl(b, await checked(b, args.url), { parent_url: null, link_text: null, link_context: null, via: "url" });
  const { url, info } = await element(b, args.ref);
  if (info.role !== "link" || !info.url) throw new Error(`ref ${args.ref} is a ${info.role}, not a link: acquire takes a link's ref`);
  return fetchUrl(b, await checked(b, info.url), { parent_url: url, link_text: info.name, link_context: info.context, via: "link" });
}
