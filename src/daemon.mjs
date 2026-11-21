#!/usr/bin/env node
// The browser daemon: one service on 127.0.0.1 speaking MCP over Streamable HTTP, with a headed Chrome of its
// own per caller, addressed by a handle. The source policy (policy.mjs, moved) and the proxy that enforces it
// per browser (proxy.mjs, new) keep every browser off local and private hosts. The launch, time limits, audit
// log and the browse actions are moved from the page readers' browser server (browsers.mjs, browse.mjs), with its
// page outline (snapshot.mjs); the web and news searches are moved too (search.mjs, google-news.mjs) and need no
// browser. The profile root variable is moved
// from the same server; profiles.mjs is new. Saving pages and documents into a caller's save_dir is moved too
// (acquire.mjs, pages.mjs), and so is the code console, which runs caller code in a child process per browser
// (console.mjs, console-child.mjs). This file is the wiring: environment, HTTP, tools, signals.

import { createRequire } from "node:module";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { CallTimeout, close, closeAll, configure, ensureBrowser, exitSync, get, limited, log, resetBrowser, run, searchLog, start } from "./browsers.mjs";
import { back, click, observe, open, screenshot, scroll, select, switchTab, tabs, text, typeInto } from "./browse.mjs";
import { VIEW_CHARS } from "./snapshot.mjs";
import { acquire } from "./acquire.mjs";
import { CODE_CHARS, DESCRIPTION, evaluate, killBrowser } from "./console.mjs";
import { testLookup } from "./policy.mjs";
import { checkProfileRoot } from "./profiles.mjs";
import { search } from "./search.mjs";
import { EDITIONS, googleNews } from "./google-news.mjs";

function fail(message) {
  process.stderr.write(`browser-mcp: ${message}\n`);
  process.exit(1);
}

const env = process.env;
for (const name of ["BROWSER_PORT", "BROWSER_BASE_PROFILE", "BROWSER_STATE_DIR", "BROWSER_PROFILE_ROOT", "BROWSER_MINIMAX_KEY"]) {
  if (!env[name]) fail(`${name} is required`);
}
const PORT = Number(env.BROWSER_PORT);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) fail("BROWSER_PORT must be a TCP port number");
if (!statSync(env.BROWSER_BASE_PROFILE, { throwIfNoEntry: false })?.isDirectory()) {
  fail(`BROWSER_BASE_PROFILE is not a directory: ${env.BROWSER_BASE_PROFILE}`);
}
// Before app.listen, so before configure() wipes the clones: a root that overlapped them would lose its profiles.
try {
  checkProfileRoot({ root: env.BROWSER_PROFILE_ROOT, baseProfile: env.BROWSER_BASE_PROFILE, clones: join(env.BROWSER_STATE_DIR, "profiles") });
} catch (error) {
  fail(error.message);
}

// Rewritten requests carry the MiniMax key: the test origin must stay on this machine.
if (env.BROWSER_TEST_SEARCH_ORIGIN && !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(env.BROWSER_TEST_SEARCH_ORIGIN)) {
  fail("BROWSER_TEST_SEARCH_ORIGIN must be http://127.0.0.1:<port>: requests sent there carry the MiniMax key");
}

// Offline tests only: a map that replaces DNS. Without the fixture proxy, Chrome would use real DNS while the
// policy read the map, so a mapped name could make a private host look public.
let lookup;
if (env.BROWSER_TEST_HOSTS) {
  if (!env.BROWSER_TEST_PROXY) fail("BROWSER_TEST_HOSTS needs BROWSER_TEST_PROXY: without the fixture proxy the map would weaken the source policy");
  try {
    lookup = testLookup(env.BROWSER_TEST_HOSTS);
  } catch (error) {
    fail(error.message);
  }
}

/** A save_dir from start: absolute, an existing directory, writable; kept by its real path. */
function checkSaveDir(dir) {
  if (!isAbsolute(dir)) throw new Error(`save_dir must be an absolute path: ${dir}`);
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`save_dir is not an existing directory: ${dir}`);
  try {
    accessSync(dir, constants.W_OK);
  } catch {
    throw new Error(`save_dir is not writable: ${dir}`);
  }
  return realpathSync(dir);
}

const VERSION = createRequire(import.meta.url)("../package.json").version;

function reply(value, isError = false) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 1) }],
    ...(isError ? { isError: true } : {}) };
}

const TEST_LIMIT = Number(env.BROWSER_TEST_CALL_LIMIT_MS) || undefined;
const SEARCH_LIMIT_MS = { search: TEST_LIMIT ?? 30_000, news_search: TEST_LIMIT ?? 60_000 };
// A document's fetch and its pages can take minutes; a browse call's limit is the browsers' own.
const ACQUIRE_LIMIT_MS = TEST_LIMIT ?? 360_000;

// Offline tests only: both services' origins go to a local recorder. The moved modules keep their URLs.
const ORIGINS = ["https://api.minimax.io", "https://news.google.com"];
const searchFetch = (signal) => (url, init = {}) => {
  const origin = env.BROWSER_TEST_SEARCH_ORIGIN && ORIGINS.find((o) => url.startsWith(o));
  return fetch(origin ? env.BROWSER_TEST_SEARCH_ORIGIN + url.slice(origin.length) : url, { ...init, signal });
};

// The arguments each browse action takes; any other is refused, so a misplaced one is not silently ignored
// (agents passed a url to observe and read the empty tab's error as a blocked page).
const TAKES = {
  open: ["url"], observe: ["query", "ref", "page"], text: ["page"], click: ["ref"], select: ["ref", "value"],
  type: ["ref", "value", "submit"], back: [], scroll: [], tabs: [], switch_tab: ["tab"], screenshot: [],
};

/** A download that finished after an earlier reply, added to this one: its source_id always reaches the caller. */
function withLate(value, late) {
  if (!late.length) return value;
  const note = { downloads_finished_since_last_call: late };
  if (typeof value === "string") return `${JSON.stringify(note, null, 1)}\n${value}`;
  if (value?.content) return { ...value, content: [...value.content, { type: "text", text: JSON.stringify(note, null, 1) }] };
  return { ...value, ...note };
}

/**
 * A call on one browser: its own queue and time limit, one audit line, errors the agent can act on. A browse call
 * over its limit restarts the browser; an acquire call does not (`reset`); a console call kills it first (`kill`).
 * An error that carries `browser` (what a failed script's actions caused) keeps it in the reply.
 */
async function tool(name, args, fn, { limit, reset = true, kill } = {}) {
  let b;
  try {
    b = get(args.browser); // an unknown handle fails here, before any browser is touched
  } catch (error) {
    return reply({ ok: false, error: error.message }, true);
  }
  return run(b, async () => {
    const started = Date.now();
    const callState = { cancelled: false };
    try {
      const result = await limited(name, async () => {
        await ensureBrowser(b);
        if (callState.cancelled) throw new Error("call was cancelled during browser startup");
        const value = await fn(b, callState);
        return withLate(value, await Promise.all(b.downloads.splice(0)));
      }, () => { callState.cancelled = true; }, limit);
      log(b, { type: "call", tool: name, args, ok: true, ms: Date.now() - started });
      return result?.content ? result : reply(result); // a screenshot is MCP content already
    } catch (error) {
      let message = String(error.message || error);
      if (error instanceof CallTimeout && kill) {
        await kill(b);
        resetBrowser(b, message);
        message += "; your code and its browser were killed, and the browser restarts on the next call (cookies stay, tabs are gone): open a page again";
      } else if (error instanceof CallTimeout && reset) {
        resetBrowser(b, message);
        message += "; the browser was restarted: open a page again";
      } else if (error instanceof CallTimeout) {
        message += "; the browser was not restarted: try another copy of the document, or leave it unsaved";
      }
      log(b, { type: "call", tool: name, args, ok: false, error: message, ms: Date.now() - started });
      return reply({ ok: false, error: message, ...(error.browser ? { browser: error.browser } : {}) }, true);
    }
  });
}

/** A call that needs no browser (a search): its own time limit, which aborts its requests; one audit line. */
async function searchTool(name, args, fn) {
  const started = Date.now();
  const controller = new AbortController();
  try {
    const result = await limited(name, () => fn(searchFetch(controller.signal)), () => controller.abort(), SEARCH_LIMIT_MS[name]);
    searchLog({ type: "call", tool: name, args, ok: true, ms: Date.now() - started });
    return reply(result);
  } catch (error) {
    const message = String(error.message || error);
    searchLog({ type: "call", tool: name, args, ok: false, error: message, ms: Date.now() - started });
    return reply({ ok: false, error: message }, true);
  }
}

// A calendar day: "2026-13-01" would throw a bare "Invalid time value", and "2026-02-30" would silently become 2 March.
const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(
  (d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d,
  "not a calendar day (YYYY-MM-DD)",
);

function server() {
  const s = new McpServer({ name: "browser-mcp", version: VERSION });
  s.tool(
    "start",
    `Start a browser of your own: a real, headed Chrome. Returns its handle; pass it as \`browser\` to every other call.
Without \`profile\` it runs on a throwaway copy of the base profile. With \`profile\` (the name of a profile the operator
made, e.g. a signed-in one) it runs on that profile itself, with its cookies and logins. While your browser is open no
other browser can open that profile: start fails at once, naming the browser that holds it. Your browser ends on close, after 10
idle minutes, or when the service stops. At most 4 run at once: at the cap, start fails at once, so close one or try later.
With \`save_dir\` (an absolute path to an existing directory) acquire saves pages and documents under
<save_dir>/sources/; without it nothing can be saved: acquire fails, and a download is reported as not saved.`,
    { profile: z.string().min(1).optional(), save_dir: z.string().min(1).optional() },
    async ({ profile, save_dir }) => {
      try {
        return reply({ browser: start({ profile, saveDir: save_dir === undefined ? null : checkSaveDir(save_dir) }) });
      } catch (error) {
        return reply({ ok: false, error: error.message }, true);
      }
    },
  );
  s.tool(
    "close",
    "Close your browser. A throwaway profile copy is deleted; a named profile stays, with its cookies and logins, for the next start on it.",
    { browser: z.string().min(1) },
    async ({ browser }) => {
      try {
        await close(browser, "close");
        return reply({ ok: true });
      } catch (error) {
        return reply({ ok: false, error: error.message }, true);
      }
    },
  );
  s.tool(
    "browse",
    `Browse the web in a real browser: the one \`start\` gave you. Any public site opens; local, private and
non-http addresses never do: open fails with \`<url> is blocked (<reason>)\`.
Each call has a 120 s limit: a call that runs over it fails and the browser restarts (your cookies stay).
Documents (PDF, spreadsheets) are not read here: save them with acquire.
The page is seen as its accessibility tree: each element is a line "role "name" [state] [ref=e12]";
links end with "-> URL". Refs address elements of the current tab until the page changes.
Actions (each takes only its own arguments; any other is refused by name):
- open {url}: open a web page.
- observe: the page's outline (landmarks, headings, forms and their controls, tables and lists, long
  ones cut to their first items), at most ${VIEW_CHARS} characters, saying what was left out.
- observe {query, page?}: the lines whose text, name or URL contain every word of query (any order,
  case and accents ignored), each with its path (main > table > row); options of a select are matched too.
- observe {ref, page?}: everything under one element (a table, a list, a form, a select's options).
- text {page?}: the page's visible text, in pages of 6000 characters.
- click {ref}: click a link, button or tab; a checkbox, radio or switch is toggled (new tabs and downloads are
  reported).
- select {ref, value}: choose an option of a select by its label.
- type {ref, value, submit?}: type into a field; submit presses Enter. A date shown as parts (day,
  month, year spinbuttons) takes one part per call; its refs change as it re-renders: observe again
  between parts.
- back, scroll: go back; scroll down to load more.
- tabs, switch_tab {tab}: list or switch your browser's tabs.
- screenshot: an image of the current view, in the reply; it is not kept.
How to use it:
- Start each page with observe: its outline shows forms with their fields and states, tables with their
  row counts, collapsed lists and dialogs, each element with a ref. Then observe with a query (words from
  the page) or with a ref (a whole list, table or form). Refs belong to the page as it is now: when one
  "is not on the page now", observe again.
- A query matches words, not meaning: every word must occur. Use the page's own words and language, and
  word stems ("report", not "reports"). When nothing matches, read the outline instead of rephrasing.
- When a click says another element covers it, dismiss the cookie or consent banner first (query
  "accept"); some sites show it again on each page.
- Content behind an accordion, a tab or a year button (an archive, older reports) is not on the page until
  you click it open.
- Search forms: set every filter, run the search, then check the results in the reply against your
  filters: the count, and the rows' dates against your date range. When they do not match, run the search
  again. A ticked default filter (such as "current only") can hide older entries and disable other fields:
  untick it.
- A date shown in parts: set every part, the year first, then the month, then the day.
- A click or form change that stays on the page replies with the lines that changed; one that opens a page
  replies with its text. A new tab a click opens becomes the current tab; one to a blocked address is closed,
  and the reply says so. A link that opens a document in a new tab or downloads it is acquired for you: that
  reply, or the next one, gives the source_id. Acquire a PDF's URL; do not open it.`,
    {
      browser: z.string().min(1),
      action: z.enum(Object.keys(TAKES)),
      url: z.string().optional(),
      ref: z.string().optional(),
      value: z.string().optional(),
      submit: z.boolean().optional(),
      query: z.string().optional(),
      page: z.number().int().min(1).optional(),
      tab: z.string().optional(),
    },
    async (args) => tool("browse", args, async (b) => {
      const takes = TAKES[args.action];
      const extra = Object.keys(args).filter((k) => !["browser", "action"].includes(k) && args[k] !== undefined && !takes.includes(k));
      if (extra.length) {
        throw new Error(`${args.action} takes ${takes.length ? takes.join(", ") : "nothing"}, not ${extra.join(", ")}` +
          (extra.includes("url") ? `: open the url first, then ${args.action}` : ""));
      }
      const need = (key) => {
        if (args[key] === undefined || args[key] === "") throw new Error(`${args.action} needs ${key}`);
        return args[key];
      };
      switch (args.action) {
        case "open": return open(b, need("url"));
        case "observe": return observe(b, args);
        case "text": return text(b, args.page);
        case "click": return click(b, need("ref"));
        case "select": return select(b, need("ref"), need("value"));
        case "type": return typeInto(b, need("ref"), need("value"), args.submit);
        case "back": return back(b);
        case "scroll": return scroll(b);
        case "tabs": return tabs(b);
        case "switch_tab": return switchTab(b, need("tab"));
        case "screenshot": return screenshot(b);
      }
      throw new Error(`unknown action ${args.action}`);
    }),
  );
  s.tool(
    "acquire",
    `Save a source so it can be read and cited: only acquired sources can be cited. Needs a browser started with
save_dir. Give one of: url (a document's or web page's URL, e.g. from search or a page), ref (an observed link's
ref), or current_page: true (save the web page now open). A document (PDF, spreadsheet) is saved as fetched; a web
page (an HTML report or release) is opened in the browser and saved with its text and image.
Returns the source_id and its files under <save_dir>/sources/<source_id>/ (PDF pages as pages/NNNN.txt and NNNN.png;
an xlsx's sheets as pages/NNNN.txt, the sheet's number cited as page; a page as original.html, text.txt and page.png),
its provenance and the publication evidence code found. The same bytes saved again keep their source_id. Cite
sources by this source_id. Each call has a ${ACQUIRE_LIMIT_MS / 60_000}-minute limit; one that runs over it fails and the
browser is not restarted. A link into a site's inline document viewer stands for the document it shows: acquire the
document's own URL. Publication date: http_last_modified can be the day the file was fetched (newswires); prefer the
date printed on the document or listed next to it, or pdf_created.`,
    { browser: z.string().min(1), url: z.string().optional(), ref: z.string().optional(), current_page: z.boolean().optional() },
    async (args) => tool("acquire", args, (b) => acquire(b, args), { limit: ACQUIRE_LIMIT_MS, reset: false }),
  );
  s.tool(
    "browser_eval",
    DESCRIPTION(TEST_LIMIT ?? 120_000),
    { browser: z.string().min(1), code: z.string().min(1).max(CODE_CHARS) },
    async (args) => tool("browser_eval", args, (b, callState) => evaluate(b, args.code, callState), { kill: killBrowser }),
  );
  s.tool(
    "search",
    `Search the web through MiniMax (up to 10 results: title, url, snippet, date). Use it to find where a document
is; a search result is never evidence: open or acquire the source itself. Refine the query to see other results.
A site's own search (a register's or an archive's) finds documents a web search misses: use web search to learn
which site to search. Needs no browser. Each call has a ${SEARCH_LIMIT_MS.search / 1000} s limit.`,
    { query: z.string().min(2) },
    async (args) => searchTool("search", args, (f) => search(f, { query: args.query, key: env.BROWSER_MINIMAX_KEY })),
  );
  s.tool(
    "news_search",
    `Google News' headlines for a query in one edition (${Object.keys(EDITIONS).join(", ")}; default US: its language and
country), published between from and to (YYYY-MM-DD, UTC days). Returns up to 50 items, newest first: title, outlet,
site (the outlet's address), published, url (the outlet's page) and google_url (Google's redirect). A url is null
where Google's link did not decode, and the note says why: then find the outlet's page by its title. Paywalled
outlets are listed too. A headline is never evidence and is not the page: open or acquire the page before you say
what it says. Needs no browser. Each call has a ${SEARCH_LIMIT_MS.news_search / 1000} s limit.`,
    { query: z.string().min(2), from: DAY, to: DAY, edition: z.enum(Object.keys(EDITIONS)).optional() },
    async (args) => searchTool("news_search", args, (f) => {
      if (args.from > args.to) throw new Error(`from ${args.from} is after to ${args.to}`);
      return googleNews(f, { ...args, edition: args.edition ?? "US" });
    }),
  );
  return s;
}

const app = createMcpExpressApp({ host: "127.0.0.1" });
// Stateless: a fresh server and transport per POST. The browsers are module state of browsers.mjs, never of a connection.
app.post("/mcp", async (req, res) => {
  try {
    const s = server();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      s.close();
    });
    await s.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    process.stderr.write(`browser-mcp: request failed: ${error.stack || error}\n`);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
});
const notAllowed = (req, res) => res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
app.get("/mcp", notAllowed);
app.delete("/mcp", notAllowed);

// The startup cleanup runs only once the port is ours: a second daemon started by mistake on the same
// environment fails here without deleting the running one's profile copies. Express 5 calls back with a
// listen error too.
const http = app.listen(PORT, "127.0.0.1", (error) => {
  if (error) fail(`cannot listen on 127.0.0.1:${PORT}: ${error.message}`);
  // Offline tests only: the fixture proxy that plays the internet is the policy proxy's upstream, the host map
  // replaces DNS, every call limit is shortened to see one run over, and so is the idle limit; a document's
  // preparation can be slowed to see one run long.
  configure({
    baseProfile: env.BROWSER_BASE_PROFILE,
    profileRoot: env.BROWSER_PROFILE_ROOT,
    stateDir: env.BROWSER_STATE_DIR,
    proxy: env.BROWSER_TEST_PROXY,
    lookup,
    callLimitMs: TEST_LIMIT,
    screenshotMs: TEST_LIMIT ? 2_000 : undefined,
    prepareDelayMs: Number(env.BROWSER_TEST_PREPARE_MS) || undefined,
    idleMs: Number(env.BROWSER_TEST_IDLE_MS) || undefined,
  });
  process.stderr.write(`browser-mcp listening on http://127.0.0.1:${PORT}/mcp\n`);
});

// Every browser's display and profile copy go with the daemon however the process ends: on SIGINT, patchright's own
// handler closes Chrome and exits (130) before an async cleanup is done.
process.on("exit", exitSync);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    http.close();
    closeAll("shutdown").then(() => process.exit(0));
  });
}
