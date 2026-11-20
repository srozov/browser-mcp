## Project overview

A browser MCP server: it gives agents a real, persistent browser (patchright on Chrome) through MCP tools.
Today the repository holds the first version, a single server with one `stagehand_eval` tool
(`stagehand-mcp.mjs`, see README.md). It is being reworked into a browser service that many agents and
pipelines share: one browser and one profile per caller, typed browsing and saving tools, a REPL, web search.
The epic and its architecture issue on this repository's GitHub issues describe where it is going; the first
build ticket replaces `stagehand-mcp.mjs`.

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
- **By hand**, today: `npm ci`, then start the server over stdio with an MCP client, for example
  `npx @modelcontextprotocol/inspector node stagehand-mcp.mjs`, with the environment the README's
  "Configure" section names. Stop it by closing the client; no browser may be left running. When the server
  changes, the change updates this section with it.

## Work

- Tickets are GitHub issues: an epic, its architecture issue, and `build` and `decision` tickets.
- One pull request per ticket, in small Conventional Commits, each with a body that says why.
