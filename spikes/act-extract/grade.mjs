#!/usr/bin/env node
// Grades the spike's runs and totals them against #5's decision rule.
//   node grade.mjs <out dir>
// Prints the report's tables (Markdown) and writes <out dir>/summary.json.
//
// A run succeeds when its session ended with a result, every check of its task is in its report (case, spacing,
// curly quotes and dash kinds aside), and, for a "save a document" task, a PDF whose first page holds the task's
// marker is in its save directory. A "listings" task (T11) succeeds when its report gives at least `min` distinct
// listings that a bike search of the reference set returned (listings-reference.mjs; every reference-*.json in the
// out dir, unioned), each with the title and one of the prices that listing's result card shows.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// MiniMax list prices (a helper, or a MiniMax caller), USD per million tokens. A cache write is priced as input.
const HELPER_PRICES = {
  "MiniMax-M3.1-Flash": { input: 0.15, output: 0.6, cache_read: 0.015 },
  "MiniMax-M3": { input: 0.3, output: 1.2, cache_read: 0.06 },
};
const READ_ONLY_TASKS = ["T01", "T02", "T07", "T08"]; // no clicking or typing: what an extract-only tool would face

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("usage: node grade.mjs <out dir>");
  process.exit(2);
}
const tasks = Object.fromEntries(JSON.parse(readFileSync(join(here, "tasks.json"), "utf8")).map((t) => [t.id, t]));

const norm = (s) => String(s ?? "").normalize("NFKC").replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/[‐-―−]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();

function files(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

function isPdf(path) {
  const fd = openSync(path, "r");
  const head = Buffer.alloc(5);
  readSync(fd, head, 0, 5, 0);
  closeSync(fd);
  return head.toString() === "%PDF-";
}

function savedPdf(saveDir, marker) {
  return files(saveDir).some((p) => {
    if (!isPdf(p)) return false;
    try {
      return norm(execFileSync("pdftotext", ["-f", "1", "-l", "1", p, "-"], { encoding: "utf8" })).includes(norm(marker));
    } catch {
      return false;
    }
  });
}

function helperCost(model, h) {
  if (!h) return 0;
  const p = HELPER_PRICES[model];
  if (!p) throw new Error(`no price for helper model ${model}`);
  return (h.input_tokens * p.input + h.cache_creation_input_tokens * p.input + h.cache_read_input_tokens * p.cache_read + h.output_tokens * p.output) / 1e6;
}

// The reference set for listings tasks: every listing the marketplace's searches returned, over all captures.
const reference = {};
for (const file of existsSync(out) ? readdirSync(out).filter((f) => /^reference-.*\.json$/.test(f)) : []) {
  const capture = JSON.parse(readFileSync(join(out, file), "utf8"));
  for (const [id, l] of Object.entries(capture.listings)) {
    const ref = (reference[id] ??= { titles: new Set(), prices: new Set(), current: [], bike: false });
    for (const t of [l.alt, ...l.lines]) if (t) ref.titles.add(norm(t));
    for (const p of l.prices) ref.prices.add(price(p));
    if (l.prices.length) ref.current.push(Number(price(l.prices[0]))); // the card's first price: the bid or the fixed price
    ref.bike ||= l.searches.some((s) => capture.bike_searches.includes(s));
  }
}

function price(text) {
  const n = Number(String(text).replace(/[^0-9.]/g, "").replace(/\.$/, ""));
  return Number.isFinite(n) ? n.toFixed(2) : null;
}

// A price field matches when one of its amounts is one the listing's card showed, or lies within the bids the
// captures saw (an auction's bid rises during a batch). A field may hold more than the price ("1'699.00 (0 Gebote)").
function priceMatches(ref, field) {
  const amounts = String(field).match(/\d{1,3}(?:'\d{3})+(?:\.\d{2})?|\d+\.\d{2}|\d+/g) ?? [];
  return amounts.map(price).some((p) => ref.prices.has(p)
    || (ref.current.length && Number(p) >= Math.min(...ref.current) && Number(p) <= Math.max(...ref.current)));
}

// One report line per listing, "title | price | URL"; a line's listing is the first marketplace URL on it.
function gradeListings(report) {
  const seen = new Map();
  for (const line of String(report ?? "").split("\n")) {
    const id = line.match(/ricardo\.ch\/[a-z]{2}\/a\/[^\s|]*-(\d{8,})/)?.[1];
    if (!id || seen.has(id)) continue;
    // The URL is the last field and the price the one before it; a title may hold a "|" of its own.
    const parts = line.replace(/\*\*/g, "").split("|").map((part) => part.trim());
    const cost = parts.length >= 3 ? parts.at(-2) : "";
    const title = parts.length >= 3 ? parts.slice(0, -2).join(" | ") : parts[0];
    seen.set(id, { title: title.replace(/^(?:[-*\u2022]|\d+[.)])\s+/, ""), cost });
  }
  const g = { reported: seen.size, in_area: 0, not_bike: 0, unknown: 0, exact: 0 };
  for (const [id, { title, cost }] of seen) {
    const ref = reference[id];
    if (!ref) { g.unknown += 1; continue; }
    if (!ref.bike) { g.not_bike += 1; continue; }
    g.in_area += 1;
    if (ref.titles.has(norm(title)) && priceMatches(ref, cost)) g.exact += 1;
  }
  return g;
}

const runs = [];
for (const agent of ["typed", "act-extract"]) {
  for (const name of existsSync(join(out, agent)) ? readdirSync(join(out, agent)).sort() : []) {
    const dir = join(out, agent, name);
    if (!existsSync(join(dir, "result.json"))) continue;
    const r = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
    const task = tasks[r.task];
    const report = norm(r.report);
    const listings = task.listings ? gradeListings(r.report) : null;
    const missing = listings ? [] : task.checks.filter((c) => !report.includes(norm(c)));
    const saved = task.saved_pdf_marker ? savedPdf(join(dir, "save"), task.saved_pdf_marker) : null;
    const ended = r.result?.subtype === "success" && !r.timed_out;
    const usage = Object.values(r.result?.modelUsage ?? {});
    // A MiniMax caller is priced from its meter's tokens; a Claude caller from the session's own cost report.
    const m = r.caller_meter;
    const callerTokens = m ? m.input_tokens + m.output_tokens + m.cache_read_input_tokens + m.cache_creation_input_tokens
      : usage.reduce((n, u) => n + u.inputTokens + u.outputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens, 0);
    const caller = m ? helperCost(r.caller_model, m) : r.result?.total_cost_usd ?? 0;
    const helper = helperCost(r.helper_model, r.helper);
    runs.push({
      agent, task: r.task, run: r.run,
      success: ended && missing.length === 0 && saved !== false && (!listings || listings.exact >= task.listings.min), listings,
      ended, missing, saved, turns: r.result?.num_turns ?? null, wall_s: r.wall_ms / 1000,
      caller_tokens: callerTokens, caller_usd: caller,
      helper_tokens: r.helper ? r.helper.input_tokens + r.helper.output_tokens + r.helper.cache_read_input_tokens + r.helper.cache_creation_input_tokens : 0,
      helper_requests: r.helper?.requests ?? 0, helper_usd: helper, total_usd: caller + helper,
      tool_calls: r.tool_calls, stagehand: r.stagehand,
      // act-extract: whether its code also read or queried the page itself (page.evaluate, innerText, ...), which
      // its prompt rules out; such a run did not get its answer through act and extract alone.
      page_code: r.stagehand ? r.stagehand.page_reads > 0 : null,
    });
  }
}

const sum = (xs, f) => xs.reduce((n, x) => n + f(x), 0);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};
function totals(rs) {
  const ok = rs.filter((r) => r.success);
  return {
    runs: rs.length, successes: ok.length, successes_without_page_code: ok.filter((r) => !r.page_code).length,
    caller_usd: sum(rs, (r) => r.caller_usd), helper_usd: sum(rs, (r) => r.helper_usd), total_usd: sum(rs, (r) => r.total_usd),
    usd_per_success: ok.length ? sum(rs, (r) => r.total_usd) / ok.length : null,
    mean_caller_tokens: rs.length ? sum(rs, (r) => r.caller_tokens) / rs.length : 0,
    mean_helper_tokens: rs.length ? sum(rs, (r) => r.helper_tokens) / rs.length : 0,
    mean_wall_s: rs.length ? sum(rs, (r) => r.wall_s) / rs.length : 0, median_wall_s: median(rs.map((r) => r.wall_s)),
  };
}
const byAgent = (rs, a) => rs.filter((r) => r.agent === a);
const summary = {
  typed: totals(byAgent(runs, "typed")), act_extract: totals(byAgent(runs, "act-extract")),
  read_only: {
    typed: totals(byAgent(runs, "typed").filter((r) => READ_ONLY_TASKS.includes(r.task))),
    act_extract: totals(byAgent(runs, "act-extract").filter((r) => READ_ONLY_TASKS.includes(r.task))),
  },
};
const t = summary.typed;
const a = summary.act_extract;
summary.rule = {
  act_extract_succeeds_at_least_as_often: a.successes >= t.successes,
  act_extract_costs_less: a.total_usd < t.total_usd,
};
summary.rule.add_act_extract = summary.rule.act_extract_succeeds_at_least_as_often && summary.rule.act_extract_costs_less;
summary.runs = runs;
writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 1));

const usd = (x) => (x === null ? "–" : `$${x.toFixed(4)}`);
const row = (cells) => `| ${cells.join(" | ")} |`;
const lines = [];
lines.push("### Per agent", "", row(["Agent", "Succeeded", "Succeeded without page code", "Caller cost", "Helper cost", "Total cost", "Cost per success", "Caller tokens (mean)", "Helper tokens (mean)", "Wall time (mean / median)"]), row(Array(10).fill("---")));
for (const [name, s] of [["typed", t], ["act/extract", a]]) {
  lines.push(row([name, `${s.successes}/${s.runs}`, name === "typed" ? "–" : `${s.successes_without_page_code}/${s.runs}`, usd(s.caller_usd), usd(s.helper_usd), usd(s.total_usd), usd(s.usd_per_success),
    Math.round(s.mean_caller_tokens).toLocaleString("en"), Math.round(s.mean_helper_tokens).toLocaleString("en"), `${s.mean_wall_s.toFixed(0)} s / ${s.median_wall_s.toFixed(0)} s`]));
}
lines.push("", "### Read-only tasks (T01, T02, T07, T08)", "", row(["Agent", "Succeeded", "Total cost", "Wall time (mean)"]), row(Array(4).fill("---")));
for (const [name, s] of [["typed", summary.read_only.typed], ["act/extract", summary.read_only.act_extract]]) {
  lines.push(row([name, `${s.successes}/${s.runs}`, usd(s.total_usd), `${s.mean_wall_s.toFixed(0)} s`]));
}
lines.push("", "### Per task", "", row(["Task", "Kind", "Typed: succeeded", "Typed: cost (mean)", "Typed: wall (mean)", "Act/extract: succeeded", "Act/extract: cost (mean)", "Act/extract: wall (mean)"]), row(Array(8).fill("---")));
for (const id of Object.keys(tasks)) {
  const cells = [id, tasks[id].kind];
  for (const agent of ["typed", "act-extract"]) {
    const rs = runs.filter((r) => r.agent === agent && r.task === id);
    const s = totals(rs);
    cells.push(`${s.successes}/${s.runs}`, usd(rs.length ? s.total_usd / rs.length : 0), `${s.mean_wall_s.toFixed(0)} s`);
  }
  lines.push(row(cells));
}
lines.push("", "### Every run", "", row(["Agent", "Task", "Run", "Result", "Page code", "Turns", "Caller", "Helper (requests)", "Total", "Wall"]), row(Array(10).fill("---")));
for (const r of runs) {
  const why = r.listings && r.ended ? `${r.listings.exact} exact, ${r.listings.in_area} in area, ${r.listings.reported} given${r.listings.not_bike ? `, ${r.listings.not_bike} not bikes` : ""}${r.listings.unknown ? `, ${r.listings.unknown} unknown` : ""}`
    : r.success ? "ok" : !r.ended ? "no result" : [r.missing.length ? `missing ${r.missing.length} of ${tasks[r.task].checks.length}` : "", r.saved === false ? "not saved" : ""].filter(Boolean).join(", ");
  lines.push(row([r.agent, r.task, r.run, why, r.page_code === null ? "–" : r.page_code ? "yes" : "no", r.turns, usd(r.caller_usd), r.agent === "typed" ? "–" : `${usd(r.helper_usd)} (${r.helper_requests})`, usd(r.total_usd), `${r.wall_s.toFixed(0)} s`]));
}
lines.push("", `Decision rule: act/extract succeeds at least as often: ${summary.rule.act_extract_succeeds_at_least_as_often}; costs less in total: ${summary.rule.act_extract_costs_less}; add act/extract: ${summary.rule.add_act_extract}.`);
console.log(lines.join("\n"));
