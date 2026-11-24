#!/usr/bin/env node
// One run of the act/extract spike (#5): one agent on one task, once, as a headless Claude Code session.
//   node run.mjs <typed|act-extract> <task id> <run number> <out dir>
// It writes <out dir>/<agent>/<task>-r<n>/: transcript.jsonl (the session's stream-json), result.json, save/ (the
// save directory the agent is given) and, for act-extract, helper-usage.jsonl (one line per helper-model request).
//
// Environment:
//   SPIKE_CALLER_MODEL  the calling agent's model, default claude-haiku-5-5 (the page readers' model). A MiniMax
//                       model (MiniMax-...) runs the same session on MiniMax's Anthropic-compatible API, through a
//                       meter that writes caller-usage.jsonl.
//   SPIKE_CALLER_EFFORT optional: the session's effort (low, medium, high, ...); left out, Claude Code picks it, which
//                       for a model it does not know is "high"
//   SPIKE_DAEMON_URL    typed: the daemon's MCP URL, e.g. http://127.0.0.1:<port>/mcp
//   SPIKE_OLD_SERVER    act-extract: the path of stagehand-mcp.mjs from commit 58fb9db, its dependencies installed
//   SPIKE_HELPER_MODEL  act-extract: the helper model on MiniMax's Anthropic-compatible API
//   MINIMAX_API_KEY     act-extract, or a MiniMax caller: the MiniMax key. Only this process holds it: the session
//                       and the old server get a placeholder and call MiniMax through a local meter, which adds the key
//                       and records each response's usage.
//   SPIKE_DENIED_TOOLS  optional: more tools to keep out of both agents' sessions, comma-separated, such as the tools
//                       of a plugin that loads into every session on the machine
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HELPER_ORIGIN = "https://api.minimax.io";
const RUN_LIMIT_MS = 15 * 60_000;
const here = dirname(fileURLToPath(import.meta.url));

const [agent, taskId, runNo, outArg] = process.argv.slice(2);
if (!["typed", "act-extract"].includes(agent) || !taskId || !/^\d+$/.test(runNo ?? "") || !outArg) {
  console.error("usage: node run.mjs <typed|act-extract> <task id> <run number> <out dir>");
  process.exit(2);
}
const task = JSON.parse(readFileSync(join(here, "tasks.json"), "utf8")).find((t) => t.id === taskId);
if (!task) throw new Error(`unknown task ${taskId}`);
const dir = resolve(outArg, agent, `${taskId}-r${runNo}`);
if (existsSync(dir)) throw new Error(`${dir} exists: a run is never overwritten`);
const saveDir = join(dir, "save");
mkdirSync(saveDir, { recursive: true });

function need(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for ${agent}`);
  return value;
}

// A response's usage: a JSON body's `usage`, or for a stream (server-sent events) the largest value of each field
// over its events (message_start carries the input tokens, message_delta the running output count).
function usageOf(body) {
  try {
    const json = JSON.parse(body);
    return { model: json.model, usage: json.usage ?? null };
  } catch {}
  const usage = {};
  let model = null;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let event;
    try { event = JSON.parse(line.slice(5)); } catch { continue; }
    model ??= event.message?.model ?? null;
    for (const [k, v] of Object.entries(event.message?.usage ?? event.usage ?? {})) {
      if (typeof v === "number") usage[k] = Math.max(usage[k] ?? 0, v);
    }
  }
  return { model, usage: Object.keys(usage).length ? usage : null };
}

// A meter: forwards model calls to MiniMax with the real key, passes streams through as they arrive, and logs each
// response's usage. The old server's helper calls go through one; with a MiniMax caller, so do the session's own.
function startMeter(key, logPath) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const started = Date.now();
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!["host", "content-length", "connection", "x-api-key", "authorization", "accept-encoding"].includes(k)) headers[k] = v;
    }
    headers["x-api-key"] = key;
    // Claude Code puts the signed-in account's and the device's ids in each request's metadata: they stay here.
    let requestBody = chunks.length ? Buffer.concat(chunks) : undefined;
    try {
      const json = JSON.parse(requestBody);
      if (json.metadata) {
        delete json.metadata;
        requestBody = JSON.stringify(json);
      }
    } catch {}
    try {
      const r = await fetch(HELPER_ORIGIN + req.url, { method: req.method, headers, body: requestBody });
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
      let body = "";
      const decoder = new TextDecoder();
      for await (const chunk of r.body ?? []) {
        res.write(chunk);
        body += decoder.decode(chunk, { stream: true });
      }
      res.end();
      const line = { t: new Date().toISOString(), ms: Date.now() - started, status: r.status, path: req.url, ...usageOf(body) };
      if (!line.usage) line.body_start = body.slice(0, 200).replaceAll(key, "<key>"); // an error page, recorded without usage
      appendFileSync(logPath, JSON.stringify(line) + "\n");
    } catch (err) {
      appendFileSync(logPath, JSON.stringify({ t: new Date().toISOString(), error: String(err.message) }) + "\n");
      if (res.headersSent) return res.end();
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "meter_error", message: String(err.message) } }));
    }
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

// A display of the old server's own (it launches headed Chrome, like the daemon).
function startXvfb() {
  const proc = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", "1280x1024x24", "-nolisten", "tcp"], { stdio: ["ignore", "ignore", "ignore", "pipe"] });
  return new Promise((ok, fail) => {
    proc.stdio[3].on("data", (d) => ok({ name: `:${String(d).trim()}`, proc }));
    proc.once("exit", (code) => fail(new Error(`Xvfb exited with ${code}`)));
    setTimeout(() => fail(new Error("Xvfb did not report a display")), 15_000);
  });
}

function freePort() {
  const s = createNetServer();
  return new Promise((ok) => s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); }));
}

// Closes a daemon browser the agent left open (raw MCP over Streamable HTTP), so the next runs stay under the cap.
async function closeBrowser(url, browser) {
  let session = null;
  const call = async (body) => {
    const r = await fetch(url, { method: "POST", body: JSON.stringify(body), headers: {
      "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26",
      ...(session ? { "mcp-session-id": session } : {}) } });
    session ??= r.headers.get("mcp-session-id");
    return r.text();
  };
  await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "spike", version: "1" } } });
  await call({ jsonrpc: "2.0", method: "notifications/initialized" });
  return call({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "close", arguments: { browser } } });
}

const cleanup = [];
let mcp;
let allowed;
// Neither agent may call a tool it is not allowed; denying one also keeps it out of the model's tool list.
const disallowed = (process.env.SPIKE_DENIED_TOOLS ?? "").split(",").filter(Boolean);
let helperModel = null;
if (agent === "typed") {
  mcp = { mcpServers: { browser: { type: "http", url: need("SPIKE_DAEMON_URL") } } };
  allowed = ["mcp__browser__start", "mcp__browser__browse", "mcp__browser__acquire", "mcp__browser__browser_eval", "mcp__browser__close"];
  disallowed.push("mcp__browser__search", "mcp__browser__news_search");
} else {
  helperModel = need("SPIKE_HELPER_MODEL");
  const meter = await startMeter(need("MINIMAX_API_KEY"), join(dir, "helper-usage.jsonl"));
  cleanup.push(() => meter.close());
  const display = await startXvfb();
  cleanup.push(() => display.proc.kill());
  mcp = { mcpServers: { stagehand: { type: "stdio", command: process.execPath, args: [need("SPIKE_OLD_SERVER")], env: {
    MINIMAX_API_KEY: "held-by-the-meter", MODEL_NAME: helperModel, MODEL_BASE_URL: `${meter.url}/anthropic/v1`,
    BROWSER_PROFILE: join(dir, "profile"), CDP_PORT: String(await freePort()), DISPLAY: display.name,
    HOME: process.env.HOME, PATH: process.env.PATH } } } };
  allowed = ["mcp__stagehand__stagehand_eval", "mcp__stagehand__stagehand_screenshot", "mcp__stagehand__stagehand_close"];
}
writeFileSync(join(dir, "mcp.json"), JSON.stringify(mcp, null, 1));

const callerModel = process.env.SPIKE_CALLER_MODEL || "claude-haiku-5-5";
// The session's environment, without the helper's key. A MiniMax caller talks to MiniMax's Anthropic-compatible API
// through a meter of its own, set here for this session only (no Claude Code setting changes), every model slot on it.
const sessionEnv = { ...process.env };
delete sessionEnv.MINIMAX_API_KEY;
const callerOnMiniMax = callerModel.startsWith("MiniMax-");
if (callerOnMiniMax) {
  const meter = await startMeter(need("MINIMAX_API_KEY"), join(dir, "caller-usage.jsonl"));
  cleanup.push(() => meter.close());
  delete sessionEnv.ANTHROPIC_API_KEY;
  Object.assign(sessionEnv, {
    ANTHROPIC_BASE_URL: `${meter.url}/anthropic`, ANTHROPIC_AUTH_TOKEN: "held-by-the-meter",
    ANTHROPIC_MODEL: callerModel, ANTHROPIC_SMALL_FAST_MODEL: callerModel, ANTHROPIC_DEFAULT_HAIKU_MODEL: callerModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: callerModel, ANTHROPIC_DEFAULT_OPUS_MODEL: callerModel,
    CLAUDE_CODE_SUBAGENT_MODEL: callerModel, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  });
}
const callerEffort = process.env.SPIKE_CALLER_EFFORT || null;
const args = [
  "-p", `${task.prompt}\n\nSave directory: ${saveDir}`,
  "--model", callerModel,
  ...(callerEffort ? ["--effort", callerEffort] : []),
  "--system-prompt", readFileSync(join(here, `${agent}.md`), "utf8"),
  "--tools", "Read,Grep,Glob",
  "--mcp-config", join(dir, "mcp.json"), "--strict-mcp-config",
  "--setting-sources", "",
  "--permission-mode", "dontAsk",
  "--allowedTools", [...allowed, "Read", "Grep", "Glob"].join(","),
  ...(disallowed.length ? ["--disallowedTools", disallowed.join(",")] : []),
  "--output-format", "stream-json", "--verbose",
  "--no-session-persistence", "--disable-slash-commands",
];

const started = Date.now();
const child = spawn("claude", args, { cwd: dir, env: sessionEnv, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.pipe(createWriteStream(join(dir, "transcript.jsonl")));
child.stderr.pipe(createWriteStream(join(dir, "stderr.txt")));
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
}, RUN_LIMIT_MS);
const exitCode = await new Promise((ok) => child.once("exit", (code, signal) => ok(code ?? signal)));
clearTimeout(timer);
const wallMs = Date.now() - started;
await new Promise((ok) => setTimeout(ok, 1000)); // let the transcript stream flush

// What the transcript says: the result message, the tool calls, and what the act-extract agent's code did.
const events = readFileSync(join(dir, "transcript.jsonl"), "utf8").split("\n").filter(Boolean).flatMap((l) => {
  try { return [JSON.parse(l)]; } catch { return []; }
});
const result = events.findLast((e) => e.type === "result") ?? null;
const toolCalls = {};
const stagehand = { act: 0, extract: 0, observe: 0, page_reads: 0 };
const handles = new Set();
let closed = false;
for (const e of events) {
  for (const block of e.type === "assistant" ? e.message?.content ?? [] : []) {
    if (block.type !== "tool_use") continue;
    toolCalls[block.name] = (toolCalls[block.name] ?? 0) + 1;
    if (block.name === "mcp__browser__close") closed = true;
    const code = String(block.input?.code ?? "");
    stagehand.act += code.match(/stagehand\.act\(/g)?.length ?? 0;
    stagehand.extract += code.match(/stagehand\.extract\(/g)?.length ?? 0;
    stagehand.observe += code.match(/stagehand\.observe\(/g)?.length ?? 0;
    stagehand.page_reads += code.match(/\.(content|innerText|textContent|innerHTML|evaluate)\(/g)?.length ?? 0;
  }
  for (const block of e.type === "user" ? e.message?.content ?? [] : []) {
    const text = JSON.stringify(block.content ?? "");
    for (const m of text.matchAll(/\\"browser\\": \\"([A-Za-z0-9_-]{16})\\"/g)) handles.add(m[1]);
  }
}
// A meter's totals over the run: requests, failed requests and tokens.
function meterTotals(path) {
  const t = { requests: 0, failed: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  for (const line of existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : []) {
    const u = JSON.parse(line);
    t.requests += 1;
    if (u.status !== 200) t.failed += 1;
    for (const k of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) t[k] += u.usage?.[k] ?? 0;
  }
  return t;
}
const helper = agent === "act-extract" ? meterTotals(join(dir, "helper-usage.jsonl")) : null;
const callerMeter = callerOnMiniMax ? meterTotals(join(dir, "caller-usage.jsonl")) : null;

for (const fn of cleanup) fn();
if (agent === "act-extract") spawn("pkill", ["-f", join(dir, "profile")]);
const leftOpen = agent === "typed" && !closed ? [...handles] : [];
for (const h of leftOpen) await closeBrowser(process.env.SPIKE_DAEMON_URL, h).catch(() => {});

writeFileSync(join(dir, "result.json"), JSON.stringify({
  agent, task: taskId, run: Number(runNo), caller_model: callerModel, caller_effort: callerEffort, helper_model: helperModel,
  exit_code: exitCode, timed_out: timedOut, wall_ms: wallMs, left_open: leftOpen,
  result: result && { subtype: result.subtype, is_error: result.is_error, num_turns: result.num_turns, duration_ms: result.duration_ms,
    total_cost_usd: result.total_cost_usd, usage: result.usage, modelUsage: result.modelUsage },
  report: result?.result ?? null, tool_calls: toolCalls, stagehand: agent === "act-extract" ? stagehand : null,
  helper, caller_meter: callerMeter,
}, null, 1));
const callerSpend = callerMeter ? `${callerMeter.requests} requests, ${callerMeter.input_tokens + callerMeter.cache_read_input_tokens} input tokens` : `$${result?.total_cost_usd ?? "?"}`;
console.log(`${agent} ${taskId} r${runNo}: exit ${exitCode}${timedOut ? " (timed out)" : ""}, ${Math.round(wallMs / 1000)} s, caller ${callerSpend}`);
