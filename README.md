# browser-mcp

A local browser service for agents. One daemon on `127.0.0.1` speaks MCP over Streamable HTTP and keeps a real,
headed Chrome (patchright, on its own Xvfb display) for every caller. A caller calls `start`, gets a handle, and
passes it to every other call, so concurrent agents never see, lose or wait for each other's pages.

**Not for use yet:** until the source policy lands, browsers can reach local hosts.

## Prerequisites

Node 24, Google Chrome and Xvfb.

## Install

```
npm ci
```

## Configure

The daemon reads its environment and refuses to start without the three variables.

| Variable | Meaning |
|---|---|
| `BROWSER_PORT` | TCP port on 127.0.0.1 |
| `BROWSER_BASE_PROFILE` | an existing directory: the template profile every browser starts from (a copy) |
| `BROWSER_STATE_DIR` | the daemon's directory: `profiles/<handle>/` (copies) and `logs/<handle>.jsonl` (audit log) |

`BROWSER_TEST_*` variables exist for the tests only.

### The base profile

Run `google-chrome --user-data-dir=<dir>` on the desktop, set the profile up, quit Chrome, and point
`BROWSER_BASE_PROFILE` at `<dir>`. Each `start` copies it; the copy is deleted when its browser ends.

## Run as a service

Copy `deploy/browser-mcp.service` to `~/.config/systemd/user/`, edit its `ExecStart` path, write the three
variables to `~/.config/browser-mcp/env`, then:

```
systemctl --user enable --now browser-mcp
```

The unit's `KillMode=control-group` kills a crashed daemon's Chrome and Xvfb; a restarted daemon deletes the
copies it left.

## Use

A client's MCP config:

```json
{"mcpServers": {"browser": {"type": "http", "url": "http://127.0.0.1:<port>/mcp"}}}
```

Tools:

- `start {}`: a browser of your own; returns `{browser}`. At most 4 run at once; at the cap it fails at once.
  Chrome launches on the first `browse`.
- `browse {browser, action, ...}`: `open {url}` opens a web page; `text {page?}` reads its visible text in pages
  of 6000 characters. Documents (PDF, spreadsheets) are refused. A call over its 120 s limit fails and restarts
  that browser, which keeps its cookies.
- `close {browser}`: ends the browser and deletes its profile copy.

A browser also ends after 10 idle minutes and when the daemon stops. An unknown handle fails with a message
saying so.

## Test

`scripts/verify` installs from the lock file, checks every module parses and runs the tests, which use a local
fixture site as the browsers' proxy.
