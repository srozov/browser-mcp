#!/usr/bin/env node
// The browser daemon: one service on 127.0.0.1 speaking MCP over Streamable HTTP, with a headed Chrome of its
// own per caller, addressed by a handle. The launch, time limits, audit log and open/text are moved from the
// page readers' browser server (browsers.mjs, browse.mjs); the web and news searches are moved too (search.mjs,
// google-news.mjs) and need no browser. This file is the wiring: environment, HTTP, tools, signals.

import { createRequire } from "node:module";
import { statSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { CallTimeout, close, closeAll, configure, ensureBrowser, exitSync, get, limited, log, resetBrowser, run, searchLog, start } from "./browsers.mjs";
import { open, text } from "./browse.mjs";
import { search } from "./search.mjs";
import { EDITIONS, googleNews } from "./google-news.mjs";

function fail(message) {
  process.stderr.write(`browser-mcp: ${message}\n`);
  process.exit(1);
}

const env = process.env;
for (const name of ["BROWSER_PORT", "BROWSER_BASE_PROFILE", "BROWSER_STATE_DIR", "BROWSER_MINIMAX_KEY"]) {
  if (!env[name]) fail(`${name} is required`);
}
const PORT = Number(env.BROWSER_PORT);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) fail("BROWSER_PORT must be a TCP port number");
if (!statSync(env.BROWSER_BASE_PROFILE, { throwIfNoEntry: false })?.isDirectory()) {
  fail(`BROWSER_BASE_PROFILE is not a directory: ${env.BROWSER_BASE_PROFILE}`);
}

// Rewritten requests carry the MiniMax key: the test origin must stay on this machine.
if (env.BROWSER_TEST_SEARCH_ORIGIN && !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(env.BROWSER_TEST_SEARCH_ORIGIN)) {
  fail("BROWSER_TEST_SEARCH_ORIGIN must be http://127.0.0.1:<port>: requests sent there carry the MiniMax key");
}

const VERSION = createRequire(import.meta.url)("../package.json").version;

function reply(value, isError = false) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 1) }],
    ...(isError ? { isError: true } : {}) };
}

const TEST_LIMIT = Number(env.BROWSER_TEST_CALL_LIMIT_MS) || undefined;
const SEARCH_LIMIT_MS = { search: TEST_LIMIT ?? 30_000, news_search: TEST_LIMIT ?? 60_000 };

// Offline tests only: both services' origins go to a local recorder. The moved modules keep their URLs.
const ORIGINS = ["https://api.minimax.io", "https://news.google.com"];
const searchFetch = (signal) => (url, init = {}) => {
  const origin = env.BROWSER_TEST_SEARCH_ORIGIN && ORIGINS.find((o) => url.startsWith(o));
  return fetch(origin ? env.BROWSER_TEST_SEARCH_ORIGIN + url.slice(origin.length) : url, { ...init, signal });
};

// The arguments each browse action takes; any other is refused, so a misplaced one is not silently ignored.
const TAKES = { open: ["url"], text: ["page"] };

/** A call on one browser: its own queue and time limit, one audit line, errors the agent can act on. */
async function tool(name, args, fn) {
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
        return fn(b);
      }, () => { callState.cancelled = true; });
      log(b, { type: "call", tool: name, args, ok: true, ms: Date.now() - started });
      return reply(result);
    } catch (error) {
      let message = String(error.message || error);
      if (error instanceof CallTimeout) {
        resetBrowser(b, message);
        message += "; the browser was restarted: open a page again";
      }
      log(b, { type: "call", tool: name, args, ok: false, error: message, ms: Date.now() - started });
      return reply({ ok: false, error: message }, true);
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
    `Start a browser of your own: a real, headed Chrome on a throwaway copy of the base profile. Returns its handle;
pass it as \`browser\` to every other call. It ends on close, after 10 idle minutes, or when the service stops.
At most 4 run at once: at the cap, start fails at once, so close one or try later.`,
    {},
    async () => {
      try {
        return reply({ browser: start() });
      } catch (error) {
        return reply({ ok: false, error: error.message }, true);
      }
    },
  );
  s.tool(
    "close",
    "Close your browser and delete its profile copy.",
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
    `Browse the web in a real browser: the one \`start\` gave you.
Each call has a 120 s limit: a call that runs over it fails and the browser restarts (your cookies stay).
Documents (PDF, spreadsheets) are not read here.
Actions:
- open {url}: open a web page.
- text {page?}: the page's visible text, in pages of 6000 characters.`,
    {
      browser: z.string().min(1),
      action: z.enum(["open", "text"]),
      url: z.string().optional(),
      page: z.number().int().min(1).optional(),
    },
    async (args) => tool("browse", args, async (b) => {
      const takes = TAKES[args.action];
      const extra = Object.keys(args).filter((k) => !["browser", "action"].includes(k) && args[k] !== undefined && !takes.includes(k));
      if (extra.length) {
        throw new Error(`${args.action} takes ${takes.join(", ")}, not ${extra.join(", ")}` +
          (extra.includes("url") ? `: open the url first, then ${args.action}` : ""));
      }
      if (args.action === "open") {
        if (!args.url) throw new Error("open needs url");
        return open(b, args.url);
      }
      return text(b, args.page);
    }),
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
  // Offline tests only: route every browser through a local fixture proxy that plays the internet, shorten
  // every call limit to see one run over, and shorten the idle limit.
  configure({
    baseProfile: env.BROWSER_BASE_PROFILE,
    stateDir: env.BROWSER_STATE_DIR,
    proxy: env.BROWSER_TEST_PROXY,
    callLimitMs: TEST_LIMIT,
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
