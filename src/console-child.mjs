// The code console's child process: one per browser, connected over CDP to that browser alone, running its calls one
// at a time. Moved from the page readers' console worker; their worker thread is a process here, so caller code never
// runs in the daemon. Real Playwright, no inference and no filesystem sandbox: the browser-only rule is a prompt fence.
// The daemon kills this process and the browser on a timeout, since only killing Chrome stops page-side work.

import { chromium } from "patchright";
import { reject } from "./policy.mjs";
import { outline, parse } from "./snapshot.mjs";

const send = (message) => process.send(message);
// A dead daemon closes the channel: no child outlives it.
process.on("disconnect", () => process.exit(0));

const first = new Promise((ok) => process.once("message", ok));
const { endpoint, downloadsPath } = await first;
let browser;
try {
  browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
} catch (error) {
  send({ failed: String(error.message || error) });
  process.exit(1);
}
const context = browser.contexts()[0];
// Attaching over CDP moves Chrome's download directory. Set the daemon's back and keep this session open: detaching
// it interrupts download progress.
const control = await browser.newBrowserCDPSession();
await control.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: downloadsPath, eventsEnabled: true });

async function pageOf(targetId) {
  for (const p of context.pages()) {
    const session = await context.newCDPSession(p);
    const { targetInfo } = await session.send("Target.getTargetInfo");
    await session.detach();
    if (targetInfo.targetId === targetId) return p;
  }
  throw new Error("the browser's current tab is no longer open");
}

async function run({ targetId, code }) {
  const page = await pageOf(targetId);
  const snapshot = async (p = page) => {
    const reason = reject(p.url());
    if (reason) throw new Error(`snapshot refused ${p.url()} (${reason})`);
    const { full } = await p._snapshotForAI({ timeout: 20_000 });
    return `${p.url()}\n${outline(parse(full, p.url()), { blocked: reject })}`;
  };
  // Deliberately unrestricted server-side JS, in this process only.
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const result = await new AsyncFunction("page", "context", "snapshot", code)(page, context, snapshot);
  let json;
  try {
    json = JSON.stringify(result === undefined ? null : result);
  } catch (error) {
    throw new Error(`return a JSON-serializable value (${error.message.split("\n")[0]})`);
  }
  if (json === undefined) throw new Error("return a JSON-serializable value");
  return json;
}

process.on("message", async (call) => {
  try {
    send({ result: await run(call) });
  } catch (error) {
    // The message, and where in the caller's code it was thrown (the function's header takes two lines); the stack,
    // which names this file, goes to the audit log only.
    const at = /eval at run \(.*?\), <anonymous>:(\d+):\d+/.exec(String(error?.stack));
    const message = error instanceof Error ? error.message : String(error);
    send({ error: at ? `${message} (line ${at[1] - 2} of the code)` : message, stack: String(error?.stack || error) });
  }
});
send({ ready: true });
