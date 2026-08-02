# stagehand-repl-mcp

An MCP server that gives an LLM agent (Claude Code, Claude Desktop, or any MCP client) a persistent, scriptable browser via [Stagehand](https://github.com/browserbase/stagehand).

Instead of exposing one MCP tool per browser action (`click`, `type`, `goto`, ...), it exposes a single `stagehand_eval` tool that runs arbitrary JavaScript against a live Stagehand + Playwright session. The agent writes short async code snippets — `await page.goto(...)`, `await stagehand.act(...)`, `await stagehand.extract(...)` — and gets structured JSON back. The browser stays open between calls, so cookies, logins, and page state persist for the whole session.

No child process, no socket, no polling — Stagehand runs directly inside the MCP server process, and the browser launches lazily on the first tool call.

## Why

Browser-automation MCP servers usually wrap Playwright/Puppeteer 1:1 into dozens of tools (`browser_click`, `browser_type`, `browser_screenshot`, ...). That's a lot of round trips for anything beyond a single action, and it pushes all the sequencing logic onto the client. This server instead gives the agent a REPL: it can chain steps, branch on results, and use Stagehand's AI-driven `act`/`extract`/`observe` primitives inline, in one call.

## How it works

- **[patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright)** launches a persistent, stealth-patched Chromium/Chrome profile and exposes it over CDP.
- **[Stagehand](https://github.com/browserbase/stagehand)** connects to that browser via `cdpUrl` and provides the AI-driven `act` / `extract` / `observe` / `agent` primitives on top of plain Playwright.
- Stagehand's LLM calls go through the [Vercel AI SDK](https://sdk.vercel.ai/)'s Anthropic provider, pointed at any Anthropic-compatible endpoint (this was built against [MiniMax](https://www.minimax.io/)'s Anthropic-compatible API, but any compatible provider works by changing `MODEL_BASE_URL`/`MODEL_NAME`).
- A small `Proxy` patches tool-call arguments in the model's responses on the fly — a workaround for providers that return `arguments` as a raw string instead of a JSON array, which trips up Stagehand's tool-calling loop.
- Submitted code runs as the body of a generated `async function`, with `stagehand`, `page`, `context`, `z` (Zod), and `screenshot()` in scope — an ad hoc REPL without an actual REPL process.

## Install

```bash
git clone https://github.com/<you>/stagehand-repl-mcp.git
cd stagehand-repl-mcp
npm install
```

## Configure

Point your MCP client (e.g. Claude Code's `mcpServers` config) at the script:

```json
{
  "mcpServers": {
    "stagehand-repl": {
      "command": "node",
      "args": ["/path/to/stagehand-repl-mcp/stagehand-mcp.mjs"],
      "env": {
        "MINIMAX_API_KEY": "sk-..."
      }
    }
  }
}
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `MINIMAX_API_KEY` | *(required)* | API key for the Anthropic-compatible LLM endpoint |
| `MODEL_NAME` | `MiniMax-M2.1` | Model name passed to the provider |
| `MODEL_BASE_URL` | `https://api.minimax.io/anthropic/v1` | Base URL of the Anthropic-compatible API |
| `HEADLESS` | `false` | Set to `1`/`true` to run the browser headless |
| `CDP_PORT` | `9222` | Local CDP debugging port |
| `BROWSER_PROFILE` | `~/.stagehand-repl-mcp/browser-profile` | Persistent Chrome profile directory (cookies, logins) |

## Tools

### `stagehand_eval`

Executes JavaScript as an async function body, with these globals in scope:

- `stagehand` — the Stagehand instance (`act`, `extract`, `observe`, `agent`)
- `page` — the Playwright `Page` (`goto`, `click`, `fill`, `content`, `url`, ...)
- `context` — the Playwright `BrowserContext` (`pages`, `newPage`, `cookies`)
- `z` — Zod, for building extraction schemas
- `screenshot(path?)` — saves a full-page screenshot, returns the path

```js
// Navigate and read the URL
await page.goto('https://example.com')
return await page.url()

// AI-driven interaction
await stagehand.act('Click the login button')

// AI-driven structured extraction
const data = await stagehand.extract(
  'Get the page title',
  z.object({ title: z.string() })
)
return data
```

### `stagehand_screenshot`

Takes a full-page screenshot and returns it as an inline image.

### `stagehand_close`

Closes the browser and resets the session. The browser relaunches lazily on the next `stagehand_eval` / `stagehand_screenshot` call.

## Status

This was built as a personal tool and isn't under active development — it's shared as-is for reference. Issues and PRs may not get fast turnaround.

## License

MIT — see [LICENSE](./LICENSE).
