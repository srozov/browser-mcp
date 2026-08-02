#!/usr/bin/env node
// Stagehand REPL MCP Server — in-process browser automation
// Lazy: browser launches on first tool call, persists for the session.
// No child process, no socket — stagehand runs directly in this process.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Stagehand, AISdkClient } from "@browserbasehq/stagehand";
import { createAnthropic } from "@ai-sdk/anthropic";
import { chromium } from "patchright";
import { z } from "zod";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// --- Config ---
const SCREENSHOT_PATH = "/tmp/stagehand-screenshot.png";
const LOG_FILE = "/tmp/stagehand-mcp.log";
const MODEL_NAME = process.env.MODEL_NAME || "MiniMax-M2.1";
const MODEL_BASE_URL = process.env.MODEL_BASE_URL || "https://api.minimax.io/anthropic/v1";
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
const HEADLESS = process.env.HEADLESS === "1" || process.env.HEADLESS === "true";
const CDP_PORT = parseInt(process.env.CDP_PORT || "9222", 10);
const USER_DATA_DIR = process.env.BROWSER_PROFILE || join(homedir(), ".stagehand-repl-mcp", "browser-profile");

function log(msg) {
  writeFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`, { flag: "a" });
}

// --- MiniMax patching (fixes non-compliant 'arguments' field) ---

function fixArguments(obj) {
  if (obj && typeof obj === "object") {
    if ("arguments" in obj && typeof obj.arguments === "string") {
      obj.arguments = obj.arguments === "" ? [] : [obj.arguments];
    }
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === "object" && obj[key] !== null) {
        fixArguments(obj[key]);
      }
    }
  }
  return obj;
}

// --- Lazy browser/stagehand init ---

let evalGlobals = null;
let browserReady = false;
let browserStarting = null;
let patchrightContext = null;
let stagehand = null;

async function ensureBrowser() {
  if (browserReady) return;
  if (browserStarting) return browserStarting;
  browserStarting = initBrowser().finally(() => { browserStarting = null; });
  return browserStarting;
}

async function initBrowser() {
  log("Initializing browser...");

  if (!MINIMAX_API_KEY) {
    throw new Error("MINIMAX_API_KEY env var is required.");
  }

  // Diagnostic fetch wrapper
  async function diagnosticFetch(url, init) {
    const response = await fetch(url, init);
    if (typeof url === "string" && url.includes("/v1/messages")) {
      try {
        const body = JSON.parse(init?.body);
        const toolNames = (body.tools || []).map((t) => t.name);
        log(`[llm] REQ model=${body.model} tools=[${toolNames}]`);
      } catch {}
      const clone = response.clone();
      try {
        const json = await clone.json();
        const contentTypes = (json.content || []).map((c) => c.type);
        log(`[llm] RES stop_reason=${json.stop_reason} content_types=[${contentTypes}]`);
      } catch {}
    }
    return response;
  }

  // Set up MiniMax model with patching
  const minimaxAnthropic = createAnthropic({
    apiKey: MINIMAX_API_KEY,
    baseURL: MODEL_BASE_URL,
    fetch: diagnosticFetch,
  });

  const baseModel = minimaxAnthropic(MODEL_NAME);
  const patchedModel = new Proxy(baseModel, {
    get(target, prop, receiver) {
      if (prop === "doGenerate") {
        return async function (...args) {
          const result = await target.doGenerate.apply(target, args);
          if (result?.content) {
            for (const part of result.content) {
              if (part.type === "tool-call" && part.input) {
                try {
                  const parsed = typeof part.input === "string" ? JSON.parse(part.input) : part.input;
                  fixArguments(parsed);
                  part.input = typeof part.input === "string" ? JSON.stringify(parsed) : parsed;
                } catch {}
              }
              if (part.type === "text" && part.text) {
                try {
                  const parsed = JSON.parse(part.text);
                  fixArguments(parsed);
                  part.text = JSON.stringify(parsed);
                } catch {}
              }
            }
          }
          return result;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const llmClient = new AISdkClient({ model: patchedModel });

  // Launch patchright browser
  mkdirSync(USER_DATA_DIR, { recursive: true });
  log(`Launching patchright (headless=${HEADLESS}, cdp=${CDP_PORT}, profile=${USER_DATA_DIR})...`);

  patchrightContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: HEADLESS,
    channel: "chrome",
    viewport: { width: 600, height: 900 },
    args: [
      `--window-size=600,900`,
      `--remote-debugging-port=${CDP_PORT}`,
      `--no-first-run`,
      `--disable-session-crashed-bubble`,
      `--password-store=basic`,
    ],
    ignoreHTTPSErrors: true,
  });

  // Get CDP WebSocket URL
  const cdpWsUrl = await getCdpWsUrl(CDP_PORT);
  log(`CDP WebSocket: ${cdpWsUrl}`);

  // Connect Stagehand
  stagehand = new Stagehand({
    env: "LOCAL",
    llmClient,
    verbose: 1,
    selfHeal: true,
    domSettleTimeout: 30000,
    localBrowserLaunchOptions: { cdpUrl: cdpWsUrl },
    logger: (logLine) => log(`[stagehand] ${logLine.message}`),
  });

  await stagehand.init();

  const page = stagehand.context.pages()[0];
  const context = stagehand.context;

  // Screenshot helper
  async function screenshot(savePath) {
    const p = savePath || SCREENSHOT_PATH;
    const buf = await page.screenshot({ fullPage: true });
    writeFileSync(p, buf);
    return p;
  }

  evalGlobals = { stagehand, page, context, z, screenshot };
  browserReady = true;
  log("Browser ready.");
}

async function getCdpWsUrl(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (resp.ok) {
        const json = await resp.json();
        if (json.webSocketDebuggerUrl) return json.webSocketDebuggerUrl;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for CDP on port ${port}`);
}

// --- Cleanup ---

async function cleanup() {
  log("Shutting down browser...");
  try { await stagehand?.close(); } catch {}
  try { await patchrightContext?.close(); } catch {}
}

process.on("SIGINT", () => { cleanup().then(() => process.exit(0)); });
process.on("SIGTERM", () => { cleanup().then(() => process.exit(0)); });

// --- Code eval ---

async function evalCode(code) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction(...Object.keys(evalGlobals), code);
  return fn(...Object.values(evalGlobals));
}

async function runCode(code) {
  const startMs = Date.now();
  try {
    const result = await evalCode(code);
    const durationMs = Date.now() - startMs;
    let serialized;
    try {
      serialized = JSON.parse(JSON.stringify(result));
    } catch {
      serialized = String(result);
    }
    return { ok: true, result: serialized, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startMs;
    return { ok: false, error: err.message || String(err), stack: err.stack, durationMs };
  }
}

// --- MCP Server ---

const server = new McpServer({
  name: "stagehand-repl",
  version: "1.0.0",
  description: "Browser automation via Stagehand REPL. Execute JS code with persistent browser state.",
});

server.tool(
  "stagehand_eval",
  `Execute JavaScript code in the Stagehand browser context.

The code runs as an async function body with these globals in scope:
- stagehand: Stagehand instance (act, extract, observe, agent)
- page: Playwright Page (goto, click, fill, content, url, locator, etc.)
- context: Playwright BrowserContext (pages, newPage, cookies)
- z: Zod schema builder (for extract)
- screenshot(path?): Save screenshot to file

Use "return" to send data back. If you don't return anything, result will be null.

Examples:
  return await page.url()
  await page.goto('https://example.com')
  await stagehand.act('Click the login button')
  const data = await stagehand.extract('Get the title', z.object({ title: z.string() }))
  return data`,
  { code: z.string().describe("JavaScript code to execute in the Stagehand context") },
  async ({ code }) => {
    try {
      await ensureBrowser();
      const result = await runCode(code);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: err.message }) }],
      };
    }
  },
);

server.tool(
  "stagehand_screenshot",
  "Take a full-page screenshot of the current browser page. Returns the image directly.",
  { path: z.string().optional().describe("Save path (default: /tmp/stagehand-screenshot.png)") },
  async ({ path }) => {
    const savePath = path || SCREENSHOT_PATH;
    try {
      await ensureBrowser();
      const result = await runCode(`return await screenshot(${JSON.stringify(savePath)})`);

      if (!result.ok) {
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      const imageData = readFileSync(savePath);
      const base64 = imageData.toString("base64");

      return {
        content: [{ type: "image", data: base64, mimeType: "image/png" }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: err.message }) }],
      };
    }
  },
);

server.tool(
  "stagehand_close",
  "Close the browser and reset the session. The browser will relaunch on the next eval/screenshot call.",
  {},
  async () => {
    if (!browserReady) {
      return { content: [{ type: "text", text: "Browser is not running." }] };
    }
    try {
      await cleanup();
      browserReady = false;
      stagehand = null;
      patchrightContext = null;
      evalGlobals = null;
      log("Browser closed by stagehand_close tool.");
      return { content: [{ type: "text", text: "Browser closed." }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error closing browser: ${err.message}` }] };
    }
  },
);

// --- Start ---

async function main() {
  log("Starting stagehand-repl MCP server (lazy — browser starts on first tool call)...");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP server connected to stdio.");
}

main().catch((err) => {
  log(`Fatal: ${err.message}`);
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
