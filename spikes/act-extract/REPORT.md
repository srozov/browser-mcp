# Spike: AI-driven act/extract next to the typed tools (#5)

Run on 2026-11-22, in two rounds:
- **round 1:** 10 read tasks of the kinds #5 names;
- **round 2:** a new problem, extracting listings from a marketplace's search page, the kind of page the typed tools
  were not built on.

## Question

On the same tasks, do Stagehand's `act` and `extract`, run by a separate, cheaper helper model, succeed at least as
often as the daemon's typed tools, at a lower total cost (the calling agent plus the helper model)?

**Decision rule (#5):** add only the tools that succeed at least as often as the typed tools at a lower total cost,
over the 20 runs per agent. A tie in success, or a higher cost, keeps the core typed-only.

## Setup

**Two agents, each a headless Claude Code session (`claude -p`) on Claude Haiku 5.5, the page readers' model.** Each
had its own short system prompt ([typed.md](typed.md), [act-extract.md](act-extract.md)), its browser tools and
`Read`, `Grep` and `Glob`, and nothing else: no web search, no shell, no settings or `CLAUDE.md` loaded.

- **Typed agent:** the daemon at `f0648a4` (master, after #21), its typed tools (`start`, `browse`, `acquire`,
  `close`) and the code console (`browser_eval`). The searches were withheld.
- **Act/extract agent:** this repository's first server, `stagehand-mcp.mjs` from `58fb9db`, run as it is: its own
  headed Chrome, and `stagehand_eval` with Stagehand 3.1's `act` and `extract`.
  - Its prompt tells it to click and type with `act` and to read pages with `extract`, not by returning a page's
    HTML or text.
  - It has no save tool, so it saves a PDF with a few lines of code (`fetch`, then a file write) and reads it with
    `Read`.

**The helper model: MiniMax-M3.1-Flash** on MiniMax's Anthropic-compatible API.
- The first server's default, MiniMax-M2.1, has been retired: the API answers "no longer available".
- Its `MODEL_NAME` setting chose M3.1-Flash instead, MiniMax's cheapest current model, so act/extract got their best
  chance on cost.

**10 read tasks** on real public pages, of the kinds #5 names ([tasks.json](tasks.json)):

| Task | Kind | Page | What to copy |
|---|---|---|---|
| T01 | open a page | a central bank's press release | the new rate's sentence and the effective date's |
| T02 | open a page | a paper's abstract page | the submission line and the abstract's first sentence |
| T03 | find a release on a site | python.org, from its home page | Python 3.12.0's release date line |
| T04 | find a release on a site | federalreserve.gov, from its home page | a 2024 FOMC statement's decision sentence |
| T05 | fill a search form | the RFC Editor's search | RFC 9110's title, status and month |
| T06 | fill a search form | a public company register | a company's number and incorporation date |
| T07 | copy lines from a table | a Wikipedia list's table | one building's row |
| T08 | copy lines from a table | python.org's releases table | Python 3.12's row |
| T09 | save a document | a PDF by its URL | its decision sentence, from the saved file |
| T10 | save a document | a PDF linked from a page | its abstract's first sentence, from the saved file |

Each task's answers were read off the live pages through the daemon before the runs; every page loaded in both
browsers.

**Each task ran twice with each agent:** 40 runs, 4 at a time, the two agents interleaved ([batch.mjs](batch.mjs)).

**What was measured** ([run.mjs](run.mjs), [grade.mjs](grade.mjs)):
- **Success.** The session ended with a report that holds every expected line or value (case, spacing, curly quotes
  and dash kinds aside). For T09 and T10, a PDF whose first page holds the document's title line also had to be in
  the run's save directory.
- **The caller's tokens and cost,** from the session's own usage report, at Haiku 5.5's list prices.
- **The helper's tokens and cost.**
  - A local meter between the old server and MiniMax recorded every response's usage. It also held the key, so the
    old server never had it.
  - The cost is at MiniMax's list prices for M3.1-Flash: $0.15 input, $0.60 output, $0.015 cache read, per million
    tokens.
- **Wall time:** from the session's start to its exit.

## Results (round 1)

**The rule keeps the core typed-only.** Act/extract succeeded less often (19 of 20 against 20 of 20) and cost 2.8
times as much in total ($0.166 against $0.059 for 20 runs).

| Agent | Succeeded | Caller cost | Helper cost | Total cost | Cost per success | Caller tokens (mean) | Helper tokens (mean) | Wall time (mean / median) |
|---|---|---|---|---|---|---|---|---|
| typed | 20/20 | $0.0592 | – | $0.0592 | $0.0030 | 81,337 | – | 21 s / 19 s |
| act/extract | 19/20 | $0.0329 | $0.1331 | $0.1660 | $0.0087 | 34,230 | 41,254 | 33 s / 28 s |

Costs are for all 20 runs of each agent. Caller tokens include cache reads; the callers' costs are list prices,
recomputed from the sessions' token counts and equal to what the sessions reported.

**Extract only** (#5's third option) loses too. On the four tasks that need no clicking or typing (T01, T02, T07,
T08), act/extract used only `extract`. Both agents succeeded 8 of 8 times, and act/extract cost 3.5 times as much
($0.0786 against $0.0226): a tie in success and a higher cost.

### Per task

| Task | Kind | Typed: succeeded | Typed: cost (mean) | Typed: wall (mean) | Act/extract: succeeded | Act/extract: cost (mean) | Act/extract: wall (mean) |
|---|---|---|---|---|---|---|---|
| T01 | open a page | 2/2 | $0.0031 | 17 s | 2/2 | $0.0024 | 22 s |
| T02 | open a page | 2/2 | $0.0026 | 31 s | 2/2 | $0.0030 | 23 s |
| T03 | find a release on a site | 2/2 | $0.0031 | 22 s | 2/2 | $0.0097 | 31 s |
| T04 | find a release on a site | 2/2 | $0.0043 | 26 s | 2/2 | $0.0151 | 66 s |
| T05 | fill a search form | 2/2 | $0.0024 | 17 s | 1/2 | $0.0055 | 46 s |
| T06 | fill a search form | 2/2 | $0.0037 | 23 s | 2/2 | $0.0074 | 51 s |
| T07 | copy lines from a table | 2/2 | $0.0032 | 18 s | 2/2 | $0.0288 | 26 s |
| T08 | copy lines from a table | 2/2 | $0.0024 | 18 s | 2/2 | $0.0051 | 20 s |
| T09 | save a document | 2/2 | $0.0019 | 14 s | 2/2 | $0.0016 | 12 s |
| T10 | save a document | 2/2 | $0.0028 | 22 s | 2/2 | $0.0044 | 28 s |

Act/extract was cheaper on two tasks only:
- **T01,** a short press release: one `extract` call on a small page.
- **T09,** a PDF by its URL: the agent fetched the file and read it with `Read`, without calling the helper at all.

It cost more on the other eight, and 9 times as much on T07, a long Wikipedia table.

## What the runs show

**Act/extract trades caller tokens for helper tokens, and the trade loses at these prices.**
- The act/extract caller spent 44% less than the typed caller ($0.033 against $0.059). It saw `extract`'s short
  answers instead of the page's outline or text.
- The helper then cost $0.133, five times what the caller saved:
  - every `act` and `extract` call sends the page's whole accessibility tree to the helper, uncached;
  - on T07's Wikipedia page that was about 120,000 input tokens a call, $0.018 each.
- The caller reads the same pages more cheaply:
  - Haiku 5.5 costs $0.10 per million input tokens against the helper's $0.15;
  - the caller's session caches the conversation, and a cache read costs $0.01 per million.

**The helper failed on 9 of the 58 `act` and `extract` calls** the agent wrote, in 7 of the 20 runs. The API
answered every request, but Stagehand got no usable answer from it ("No object generated: the model did not return
a response" or "could not parse the response").

**The act/extract agent read pages with its own code in 9 runs,** although its prompt told it to read through
`extract`:
- **5 runs checked `extract`'s answer** against the page's text (`innerText.includes(...)`) before copying it; in
  one of them the check itself failed to run. The answer came from `extract`; the agent did not trust it to be
  exact.
- **3 runs recovered from a failed step with page code:**
  - T04 run 1: `act` could not click a statement's link on a long calendar page, and `page.evaluate` found the link;
  - T10, both runs: `extract` could not return the PDF link's URL, and `page.evaluate` read it.

  Without that code those 3 runs fail, and act/extract by itself succeeded in 16 of 20.
- **1 run failed (T05 run 1):** `extract` twice returned an empty publication month for RFC 9110, although the
  results list shows "June 2022". The agent's page code found a neighbouring entry instead, which the agent rightly
  discarded, and its report then said that the results list shows no month.

**`act` clicked the wrong link once** (T04 run 2: the Implementation Note instead of the statement). The agent
noticed from the page title, went back and clicked again.

**The typed agent was faster:** 21 s against 33 s a run on average, and on navigation and forms 2 to 2.5 times as
fast (T04: 26 s against 66 s; T06: 23 s against 51 s). Each `act` or `extract` call waits for one or more helper
responses, 3 s at the median (1 to 18 s).

**The typed agent's own frictions,** which are not part of this decision:
- In all 20 runs, its first turn called `start` in parallel with `browse` (18 runs) or `acquire` (2 runs), passing
  a made-up handle (`b1`). That second call failed with "unknown browser", and the agent repeated it with the real
  handle.
- In 5 runs it tried `browse {action: "close"}` before `close`.

Each costs a turn. The typed totals above include them.

## What the result depends on

- **The caller's model.** At Haiku 5.5's prices the caller is cheap enough that moving page reading to a helper
  cannot pay.
  - At Sonnet 5.5's list prices ($2 input, $10 output, $0.10 cache read, per million tokens), the same token counts
    would cost $1.04 for the typed agent and $0.60 plus the helper's $0.13 for act/extract. Act/extract would be the
    cheaper one.
  - That is an estimate from these runs' tokens, not a measurement: another model would make other calls.
  - The success side of the rule would still fail.
- **The helper's model.** M3.1-Flash is MiniMax's cheapest current model. MiniMax-M3 costs twice as much, which
  would double the helper's share. A stronger helper might fail fewer `act` and `extract` calls; that was not
  tested.
- **The sample.** 10 tasks, run twice each. The success gap is one run; the cost gap held on 8 of the 10 tasks.

## Round 2: a new problem

Round 1's pages are static, well labelled and of the kind the typed tools were built on: they come from the page
readers' own server, tuned on that work. Round 2 asks whether round 1 favoured them, with a task neither agent's tools
or prompts were made for.

**The task (T11):** "Extract 50 e-mountain bike listings from ricardo.ch, within a 20 km radius of 8810 Horgen. Start
at https://www.ricardo.ch/de/. For each listing give its title and price as the site shows them, and its URL, one
listing per line: title | price | URL."
- The site is a marketplace's JavaScript search: a cookie banner, 60 results a page, and a location filter that is a
  zip-code field inside a dropdown, which reveals a radius combobox once a zip code is typed.
- Each agent ran it 3 times, 2 runs at a time, with the same prompts and harness as round 1.

**Grading** ([listings-reference.mjs](listings-reference.mjs)):
- **The reference set.** These are the listings that the marketplace's own searches return within 20 km of 8810. They
  were captured through the daemon just before and just after the runs, and once 15 minutes earlier. The searches:
  - the E-Mountainbike bike type (212 listings);
  - "e-mountainbike" in the bikes category (265);
  - "e-mtb" in the bikes category (241).

  That makes 282 listings in all. A listing that only the plain text search returns, such as a bike stand or a brake
  set, is not a bike.
- **Success.** A run succeeds when it gives 50 distinct listings from that set, each with its title as the result card
  shows it and one of the card's prices (or a bid within the range the captures saw).

| Agent | Succeeded | Without page code | Caller cost | Helper cost | Total cost | Wall time (mean) |
|---|---|---|---|---|---|---|
| typed | 1/3 | – | $0.0500 | – | $0.0500 | 184 s |
| act/extract | 3/3 | 0/3 | $0.0507 | $0.1035 | $0.1542 | 254 s |

| Agent | Run | Result | Page code | Turns | Caller | Helper (requests) | Total | Wall |
|---|---|---|---|---|---|---|---|---|
| typed | 1 | 50 exact, 50 in area, 50 given | – | 26 | $0.0136 | – | $0.0136 | 177 s |
| typed | 2 | 49 exact, 50 in area, 50 given | – | 27 | $0.0151 | – | $0.0151 | 153 s |
| typed | 3 | 36 exact, 39 in area, 50 given, 11 unknown | – | 34 | $0.0213 | – | $0.0213 | 222 s |
| act-extract | 1 | 50 exact, 50 in area, 50 given | yes | 29 | $0.0170 | $0.0542 (25) | $0.0712 | 300 s |
| act-extract | 2 | 50 exact, 50 in area, 50 given | yes | 24 | $0.0144 | $0.0192 (9) | $0.0335 | 180 s |
| act-extract | 3 | 50 exact, 50 in area, 50 given | yes | 29 | $0.0194 | $0.0301 (13) | $0.0494 | 281 s |

**`act` and `extract` failed at the task's two hard steps in every run.**
- `act` could not set the location filter in any run ("No object generated"). The agent filled the zip-code field
  with page code instead; `act` managed only the click on 20 km.
- `extract` could not return the 50 listings in one call: it failed (run 1) or returned an empty list (run 2).
  - In run 1 the agent then asked for 10 cards at a time, which gave the titles and prices; it took the URLs from
    page code.
  - Runs 2 and 3 scraped every field from the result cards with `page.evaluate`.

  Page code is what their prompt ruled out, and no run would have succeeded with `act` and `extract` alone.

**The typed agent did the same scraping with the daemon's console.**
- Its typed tools opened the search, dismissed the banner and set the filter: with `type` and `click` in run 1, and
  through `browser_eval` in run 3.
- Every run then read the result cards with `browser_eval`.

**So both agents leaned on page code over the result cards.** The typed agent's two misses were its own judgment,
not its tools:
- run 3 searched "e-mountain bike", with a space; the results include non-electric mountain bikes and brake sets. It
  kept 11 of them, and its report says so;
- run 2 joined a card's size line to one title ("E-Bike Trelago Furly 29" Grösse 46cm").

**Cost and time.**
- Act/extract cost 3.1 times as much ($0.154 against $0.050) and took longer (254 s against 184 s a run).
- These 3 act/extract runs used 7% of the MiniMax plan's 5-hour window (94% left before, 87% after).

**What round 2 shows.**
- On a problem the typed tools were not built for, `act` and `extract` did worse, not better: they failed the steps
  that make the task hard, in every run.
- What did the work for both agents is a code console over the page, which the daemon already has (`browser_eval`).
- By the rule on round 2 alone, the act/extract agent fails on cost: it succeeded more often (3 against 1 of 3) at
  3.1 times the cost. `act` and `extract` by themselves succeeded in no run.
- The sample is 3 runs each. The typed agent's misses (which search to use, what to keep) are a caller's judgment that
  a prompt could address; that was not tested.

## Decision

The rule's answer: **keep the core typed-only.**
- **Round 1:** act/extract succeeded less often (19 against 20) and cost 2.8 times as much in total. Extract alone tied
  in success at 3.5 times the cost.
- **Round 2,** a problem the typed tools were not built for: `act` and `extract` failed its hard steps in every run.
  Both agents finished it with page code. The act/extract agent succeeded more often there, at 3.1 times the cost.

For a later pipeline that relies on AI-driven steps today, this means it moves onto the daemon with an agent using
the typed tools, or keeps its own browser code. The daemon gets no `act` or `extract` tool.

## Every run (round 1)

<details>
<summary>40 runs</summary>

"Page code" marks an act/extract run whose code also read the page itself (see above).

| Agent | Task | Run | Result | Page code | Turns | Caller | Helper (requests) | Total | Wall |
|---|---|---|---|---|---|---|---|---|---|
| typed | T01 | 1 | ok | – | 8 | $0.0039 | – | $0.0039 | 19 s |
| typed | T01 | 2 | ok | – | 7 | $0.0023 | – | $0.0023 | 15 s |
| typed | T02 | 1 | ok | – | 7 | $0.0034 | – | $0.0034 | 48 s |
| typed | T02 | 2 | ok | – | 7 | $0.0019 | – | $0.0019 | 14 s |
| typed | T03 | 1 | ok | – | 9 | $0.0030 | – | $0.0030 | 22 s |
| typed | T03 | 2 | ok | – | 10 | $0.0032 | – | $0.0032 | 22 s |
| typed | T04 | 1 | ok | – | 11 | $0.0043 | – | $0.0043 | 25 s |
| typed | T04 | 2 | ok | – | 11 | $0.0044 | – | $0.0044 | 26 s |
| typed | T05 | 1 | ok | – | 6 | $0.0023 | – | $0.0023 | 17 s |
| typed | T05 | 2 | ok | – | 7 | $0.0025 | – | $0.0025 | 17 s |
| typed | T06 | 1 | ok | – | 11 | $0.0036 | – | $0.0036 | 21 s |
| typed | T06 | 2 | ok | – | 12 | $0.0038 | – | $0.0038 | 25 s |
| typed | T07 | 1 | ok | – | 9 | $0.0036 | – | $0.0036 | 19 s |
| typed | T07 | 2 | ok | – | 8 | $0.0028 | – | $0.0028 | 17 s |
| typed | T08 | 1 | ok | – | 8 | $0.0028 | – | $0.0028 | 16 s |
| typed | T08 | 2 | ok | – | 7 | $0.0020 | – | $0.0020 | 20 s |
| typed | T09 | 1 | ok | – | 6 | $0.0018 | – | $0.0018 | 13 s |
| typed | T09 | 2 | ok | – | 7 | $0.0021 | – | $0.0021 | 15 s |
| typed | T10 | 1 | ok | – | 9 | $0.0028 | – | $0.0028 | 22 s |
| typed | T10 | 2 | ok | – | 8 | $0.0029 | – | $0.0029 | 23 s |
| act-extract | T01 | 1 | ok | yes | 3 | $0.0009 | $0.0017 (4) | $0.0026 | 24 s |
| act-extract | T01 | 2 | ok | no | 2 | $0.0007 | $0.0015 (4) | $0.0022 | 21 s |
| act-extract | T02 | 1 | ok | no | 4 | $0.0012 | $0.0022 (5) | $0.0035 | 22 s |
| act-extract | T02 | 2 | ok | yes | 3 | $0.0009 | $0.0016 (4) | $0.0025 | 23 s |
| act-extract | T03 | 1 | ok | yes | 4 | $0.0011 | $0.0072 (4) | $0.0084 | 30 s |
| act-extract | T03 | 2 | ok | no | 4 | $0.0012 | $0.0097 (7) | $0.0109 | 33 s |
| act-extract | T04 | 1 | ok | yes | 7 | $0.0023 | $0.0111 (6) | $0.0134 | 56 s |
| act-extract | T04 | 2 | ok | yes | 9 | $0.0024 | $0.0145 (9) | $0.0169 | 77 s |
| act-extract | T05 | 1 | missing 1 of 3 | yes | 6 | $0.0018 | $0.0041 (5) | $0.0058 | 53 s |
| act-extract | T05 | 2 | ok | yes | 9 | $0.0030 | $0.0022 (3) | $0.0052 | 40 s |
| act-extract | T06 | 1 | ok | no | 7 | $0.0021 | $0.0043 (9) | $0.0064 | 41 s |
| act-extract | T06 | 2 | ok | no | 8 | $0.0023 | $0.0060 (11) | $0.0084 | 61 s |
| act-extract | T07 | 1 | ok | no | 4 | $0.0014 | $0.0371 (4) | $0.0385 | 31 s |
| act-extract | T07 | 2 | ok | no | 2 | $0.0007 | $0.0184 (2) | $0.0191 | 22 s |
| act-extract | T08 | 1 | ok | no | 3 | $0.0007 | $0.0043 (2) | $0.0050 | 17 s |
| act-extract | T08 | 2 | ok | no | 2 | $0.0007 | $0.0045 (2) | $0.0052 | 23 s |
| act-extract | T09 | 1 | ok | no | 3 | $0.0016 | $0.0000 (0) | $0.0016 | 12 s |
| act-extract | T09 | 2 | ok | no | 3 | $0.0016 | $0.0000 (0) | $0.0016 | 12 s |
| act-extract | T10 | 1 | ok | yes | 7 | $0.0026 | $0.0009 (1) | $0.0035 | 25 s |
| act-extract | T10 | 2 | ok | yes | 8 | $0.0036 | $0.0016 (2) | $0.0053 | 30 s |

</details>

[results.json](results.json) and [results-round2.json](results-round2.json) hold every run's numbers, as
`grade.mjs` wrote them.

## Rerun

1. Extract the first server and install its dependencies:
   `git archive 58fb9db | tar -x -C <dir> && (cd <dir> && npm ci)`.
2. Start the daemon (README.md); search is not used, so its MiniMax key may be a placeholder.
3. Set the environment both rounds use:

   ```bash
   export SPIKE_DAEMON_URL=http://127.0.0.1:<port>/mcp SPIKE_OLD_SERVER=<dir>/stagehand-mcp.mjs \
     SPIKE_HELPER_MODEL=MiniMax-M3.1-Flash MINIMAX_API_KEY=<key>
   ```

4. Round 1: run tasks T01 to T10 twice each, 4 at a time, then grade:

   ```bash
   node spikes/act-extract/batch.mjs <out dir> 2 4 T01 T02 T03 T04 T05 T06 T07 T08 T09 T10
   node spikes/act-extract/grade.mjs <out dir>
   ```

5. Round 2: capture the reference set, run T11 three times per agent, 2 at a time, capture again, then grade:

   ```bash
   node spikes/act-extract/listings-reference.mjs $SPIKE_DAEMON_URL <out dir 2>/reference-1-before.json
   node spikes/act-extract/batch.mjs <out dir 2> 3 2 T11
   node spikes/act-extract/listings-reference.mjs $SPIKE_DAEMON_URL <out dir 2>/reference-2-after.json
   node spikes/act-extract/grade.mjs <out dir 2>
   ```

Each run is a headless Claude Code session, so `claude` must be installed and signed in. The live pages can
change, so a rerun's checks may need new answers in `tasks.json`.
