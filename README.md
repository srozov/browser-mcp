# browser-mcp

A local browser service for agents. One daemon on `127.0.0.1` speaks MCP over Streamable HTTP and keeps a real,
headed Chrome (patchright, on its own Xvfb display) for every caller. A caller calls `start`, gets a handle, and
passes it to every other call, so concurrent agents never see, lose or wait for each other's pages.

## Prerequisites

Node 24, Google Chrome and Xvfb.

## Install

```
npm ci
```

## Configure

The daemon reads its environment and refuses to start without the five variables.

| Variable | Meaning |
|---|---|
| `BROWSER_PORT` | TCP port on 127.0.0.1 |
| `BROWSER_BASE_PROFILE` | an existing directory: the template profile every browser starts from (a copy) |
| `BROWSER_STATE_DIR` | the daemon's directory: `profiles/<handle>/` (copies) and `logs/<handle>.jsonl` (audit log) |
| `BROWSER_PROFILE_ROOT` | an existing directory of named profiles, one subdirectory each; it must not be, contain or sit inside the base profile or the state directory's `profiles/` |
| `BROWSER_MINIMAX_KEY` | the MiniMax API key for `search`; it is in no reply and no log |

`BROWSER_TEST_*` variables exist for the tests only.

### The base profile

Run `google-chrome --user-data-dir=<dir>` on the desktop, set the profile up, quit Chrome, and point
`BROWSER_BASE_PROFILE` at `<dir>`. Each `start` without a `profile` copies it; the copy is deleted when its
browser ends.

### Named profiles

A named profile is a caller's own, a signed-in one say. To make one, run
`google-chrome --user-data-dir=<BROWSER_PROFILE_ROOT>/<name>` on the desktop, sign in, then quit Chrome (Chrome
allows one process per profile, so quit any desktop Chrome on it before a `start`). The daemon's browsers run on
invisible displays, so sign in on the desktop, not through the daemon. `start {profile: "<name>"}` runs on it
directly: it is never copied or deleted, and the browser holds it until it ends. The daemon never creates a named
profile.

## Run as a service

Copy `deploy/browser-mcp.service` to `~/.config/systemd/user/`, edit its `ExecStart` path, write the five
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

- `start {profile?}`: a browser of your own; returns `{browser}`. With `profile` it runs on that named profile; while
  its browser is open a second `start` on it fails at once, naming the holder. At most 4 run at once; at the cap it
  fails at once.
  Chrome launches on the first `browse`.
- `browse {browser, action, ...}`, on the browser's current tab. A call over its 120 s limit fails and restarts
  that browser, which keeps its cookies. Documents (PDF, spreadsheets) are not read yet. The actions:
  - `open {url}`: open a web page;
  - `observe`: the page's accessibility outline, each element a line with a ref (`[ref=e12]`), at most 6000
    characters; `observe {query, page?}`: the lines holding every word of the query, each with its path;
    `observe {ref, page?}`: one element whole (a table, a list, a form, a select's options);
  - `text {page?}`: the visible text, in pages of 6000 characters;
  - `click {ref}`: a link, button or tab; a checkbox, radio or switch is toggled;
  - `select {ref, value}`: an option by its label;
  - `type {ref, value, submit?}`: fill a field (a date part is typed key by key); `submit` presses Enter;
  - `back`, `scroll`;
  - `tabs`, `switch_tab {tab}`: this browser's tabs only;
  - `screenshot`: an image of the current view, in the reply, never written to disk.

  An action takes only its own arguments; any other is refused by name. A ref that is malformed or no longer on
  the page fails with "observe again". A click, select or type that stays on the page replies with the lines
  that changed; one that navigates, even a moment later, replies with the new page. A new tab it opens becomes
  the current tab and is reported; one to a refused address, or showing a document, is closed. A click that
  another element covers (a cookie banner) fails, saying to dismiss it; nothing is clicked through it.
- `close {browser}`: ends the browser. A throwaway profile copy is deleted; a named profile stays.
- `search {query}`: up to 10 web results (title, url, snippet, date) through MiniMax; 30 s limit; no browser.
- `news_search {query, from, to, edition?}`: Google News headlines in the day range, newest first, at most 50,
  each with the outlet's decoded URL, or `url: null` and its `google_url`. Editions: CH, US, GB, DE, AT, FR, HK,
  CN, RU (default US); 60 s limit; no browser.

Neither search needs `start`. A search result is never evidence: open the page itself. Search calls are logged to
`logs/search-YYYY-MM-DD.jsonl`.

## Source policy

Browsers open public http(s) sites only. Local, private, loopback and link-local hosts are refused, by name and by
the addresses a name resolves to; so are non-http schemes and credentials in a URL. Every request, redirect hop and
WebSocket goes through a policy proxy of the browser's own, which connects to the address it checked; WebRTC is
limited to that proxy. A refusal is a `rejected` line in the browser's audit log, and `open` fails with
`<url> is blocked (<reason>)`.

A browser also ends after 10 idle minutes and when the daemon stops. An unknown handle fails with a message
saying so.

## Test

`scripts/verify` installs from the lock file, checks every module parses and runs the tests, which use a local
fixture site as the policy proxy's upstream. `BROWSER_TEST_HOSTS` (tests only; JSON `{name: [addresses]}`) replaces
DNS and needs `BROWSER_TEST_PROXY`.
