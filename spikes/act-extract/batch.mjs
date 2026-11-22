#!/usr/bin/env node
// Runs the spike: every task, `runs` times, with each agent, `concurrency` runs at a time, the two agents interleaved.
//   node batch.mjs <out dir> [runs=2] [concurrency=4]
// A run whose result.json exists is skipped, so a stopped batch resumes. run.mjs refuses a run directory that exists
// without one (a run that crashed): it is reported, and left for a person to look at.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [outArg, runsArg = "2", concurrencyArg = "4"] = process.argv.slice(2);
if (!outArg) {
  console.error("usage: node batch.mjs <out dir> [runs=2] [concurrency=4]");
  process.exit(2);
}
const out = resolve(outArg);
const tasks = JSON.parse(readFileSync(join(here, "tasks.json"), "utf8"));
const jobs = [];
for (let run = 1; run <= Number(runsArg); run++) {
  for (const task of tasks) for (const agent of ["typed", "act-extract"]) jobs.push({ agent, task: task.id, run });
}

let failed = 0;
async function worker() {
  for (let job = jobs.shift(); job; job = jobs.shift()) {
    const dir = join(out, job.agent, `${job.task}-r${job.run}`);
    if (existsSync(join(dir, "result.json"))) continue;
    const code = await new Promise((ok) => {
      spawn(process.execPath, [join(here, "run.mjs"), job.agent, job.task, String(job.run), out], { stdio: "inherit" }).once("exit", ok);
    });
    if (code !== 0) {
      failed += 1;
      console.error(`${job.agent} ${job.task} r${job.run}: run.mjs exited with ${code}`);
    }
  }
}
await Promise.all(Array.from({ length: Number(concurrencyArg) }, worker));
console.log(failed ? `${failed} runs did not finish` : "all runs finished");
process.exit(failed ? 1 : 0);
