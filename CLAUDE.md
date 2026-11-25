## Project overview

A browser MCP server: it gives agents a real, persistent browser (patchright on Chrome) through MCP tools.
It is a daemon (`src/daemon.mjs`): one Node service on 127.0.0.1 that speaks MCP over Streamable HTTP and
keeps one headed Chrome per caller, addressed by a handle (`start`, `browse`, `close`, see README.md). It is
being built up into a service that many agents and pipelines share: typed browsing and saving tools, a REPL,
web search.
The epic and its architecture issue on this repository's GitHub issues describe where it is going.

## This repository is public

Issues, pull requests, comments and commits are public. Write them without private project or repository
names, host names, local paths, account details or personal data: describe a use case generically ("an agent
reading a news article"), never by the private project it came from.

## Engineering principles

- **KISS:** the minimum straightforward code that solves the accepted problem: explicit control flow, typed
  interfaces, local error paths.
- **YAGNI:** no configuration, flags, interfaces or abstractions without a concrete accepted use case. No
  backward-compatibility promise to earlier drafts: reject unsupported paths explicitly.
- **DRY after the rule of three:** small local duplication is fine until a pattern has appeared three times.
- **Focused boundaries:** one concern per module, narrow interfaces.
- **Fail fast and explicitly:** unsupported or unsafe states raise clear errors; never swallow a failure or
  fall back silently.
- **Surgical scope:** change only what the task needs.
- **Verifiable goals:** state the success criteria before a multi-step change and check each step.

## Checks

- `scripts/verify` must pass on every branch: it installs from the lock file, checks that every module parses
  and runs the `*.test.mjs` tests (`node --test`). Tests use local fixtures, never live sites.
- The `verify` check (GitHub Actions, `.github/workflows/verify.yml`) runs `scripts/verify` on every pull request
  to `master` and every push to it, on the Node 24 it sets up, with the runner's Chrome, Xvfb and poppler.
- **By hand**, today:
  1. `npm ci`;
  2. start `node src/daemon.mjs` with `BROWSER_PORT`, `BROWSER_BASE_PROFILE` (an empty directory will do),
     `BROWSER_STATE_DIR` (a directory under `/tmp`), `BROWSER_PROFILE_ROOT` (a directory under `/tmp` with an
     empty subdirectory `a`) and `BROWSER_MINIMAX_KEY` (a real MiniMax key);
  3. `npx @modelcontextprotocol/inspector`, transport Streamable HTTP, URL `http://127.0.0.1:<port>/mcp`;
  4. `start`, `browse open` on a page, `browse text`, `browse observe`, `browse click` on a link's ref from it,
     `browse tabs`, `browse screenshot` (an image), `browse open http://127.0.0.1:<port>/mcp` (fails
     `is blocked (private_host)`), `acquire {current_page: true}` (fails naming `save_dir`),
     `browser_eval {code: "return {url: page.url(), outline: await snapshot()}"}` (the page's URL and outline),
     `browser_eval {code: "await page.goto('http://127.0.0.1:<port>/mcp')"}` (fails, and the browser's log has a
     `rejected` line), `browser_eval {code: "process.exit(1)"}` (fails), then `browser_eval {code: "return 1"}`
     (`value` 1), `close`;
     `start {save_dir: <an empty directory under /tmp>}`, `browse open` on a page, `acquire {current_page: true}`,
     `acquire {url}` of a public PDF (its `pages/0001.txt`, `0001.png` and `reading/0001.txt` are under
     `<save_dir>/sources/<id>/`),
     the same `acquire {url}` again ("already acquired"), `browser_eval` clicking a PDF link on a page (its
     `browser.downloads` holds the source_id), `close`; `start {profile: "a"}`, `browse open`, a second
     `start {profile: "a"}` fails naming the first, `close`; then `search` on a query and
     `news_search` on a query and a recent day range, with no `start`;
  5. stop the daemon with Ctrl-C;
  6. check that `pgrep -f <state dir>` and `pgrep -f <checkout>/src/console-child.mjs` print nothing, no Xvfb
     of its own is left, `<state dir>/profiles` and `<state dir>/downloads` are empty, `pgrep -f <profile root>`
     prints nothing, `<profile root>/a` is still there, and the save_dir holds only `sources/`; `ss -ltn` shows
     no listener of the daemon's left (its port, its browsers' proxies and their debugging ports).

  When the daemon changes, the change updates this section with it.

## Work

- Tickets are GitHub issues: an epic, its architecture issue, and `build` and `decision` tickets.
- One pull request per ticket, in small Conventional Commits, each with a body that says why.
