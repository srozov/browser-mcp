// The page model rests on a private Playwright API (`page._snapshotForAI`). The first test pins the
// format the parser reads, from a real browser: it fails when a patchright upgrade changes it. The
// others test the views on a fixed snapshot. Moved from the page readers' tests. Needs Chrome; no network.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "patchright";
import { VIEW_CHARS, outline, paged, parse, query, subtree, target } from "../src/snapshot.mjs";

let browser;
before(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
after(async () => browser?.close());

const PAGE = `<main><h1>Reports</h1>
  <ul><li>2025 Annual Report <a href="/ar-2025.pdf">Download pdf</a></li></ul>
  <label><input type="checkbox" checked> Current only</label>
  <span>Issuer</span><select><option>All</option><option selected>Zürich AG</option></select>
  <table><tr><th>Date</th></tr><tr><td>03.09.2025</td><td><a href="#/detail/1">Details</a></td></tr></table>
  <button>Search: "all"</button></main>`;

test("_snapshotForAI still writes the format the parser reads", async () => {
  const page = await browser.newPage();
  await page.setContent(PAGE);
  const { full } = await page._snapshotForAI();
  await page.close();
  const want = [
    /^- main \[ref=e\d+\]:$/m,
    /^ {2}- heading "Reports" \[level=1\] \[ref=e\d+\]$/m,
    /^ {6}- text: 2025 Annual Report$/m,
    /^ {6}- link "Download pdf" \[ref=e\d+\] \[cursor=pointer\]:\n {8}- \/url: \/ar-2025\.pdf$/m,
    /^ {4}- checkbox "Current only" \[checked\] \[ref=e\d+\]$/m,
    /^ {2}- combobox \[ref=e\d+\]:\n {4}- option "All"\n {4}- option "Zürich AG" \[selected\]$/m,
    /^ {6}- row "03\.09\.2025 Details" \[ref=e\d+\]:$/m,
    /^ {12}- \/url: "#\/detail\/1"$/m,
    /^ {2}- 'button "Search: \\"all\\"" \[ref=e\d+\]'$/m,
  ];
  for (const re of want) assert.match(full, re);
  const root = parse(full, "http://x.test/reports");
  assert.match(outline(root), /combobox \(label "Issuer"\) \[ref=e\d+\]: 2 options, selected "Zürich AG"/);
  assert.match(outline(root), /button "Search: \\"all\\"" \[ref=e\d+\]/);
});

const SNAP = `- generic [ref=e1]:
  - navigation [ref=e2]:
    - link "Home" [ref=e3] [cursor=pointer]:
      - /url: /
  - main [ref=e4]:
    - generic [ref=e5]:
      - generic [ref=e6]: Issuer
      - combobox [ref=e7]:
        - option "All" [selected]
${Array.from({ length: 40 }, (_, i) => `        - option "Issuer ${i} AG"`).join("\n")}
        - option "Café Électrique SA"
    - list [ref=e8]:
${Array.from({ length: 9 }, (_, i) => `      - listitem [ref=e${20 + i}]:
        - text: Report ${2020 + i}
        - link "PDF" [ref=e${40 + i}] [cursor=pointer]:
          - /url: /r${2020 + i}.pdf
          - img`).join("\n")}
    - 'link "Q3: results" [ref=e60]':
      - /url: https://other.test/q3`;

test("the outline collapses navigation, long lists and selects", () => {
  const o = outline(parse(SNAP, "http://ir.test/x"));
  assert.match(o, /^navigation \[ref=e2\]: 1 links \(Home\); observe ref e2 to expand$/m);
  assert.match(o, /combobox \(label "Issuer"\) \[ref=e7\]: 42 options, selected "All"/);
  assert.doesNotMatch(o, /Issuer 3 AG/);
  assert.match(o, /link "PDF" \[ref=e40\] -> http:\/\/ir\.test\/r2020\.pdf/);
  assert.match(o, /… 6 more items \(9 in all\); observe ref e8 to see them/);
  assert.doesNotMatch(o, /r2024\.pdf/);
  assert.match(o, /link "Q3: results" \[ref=e60\] -> https:\/\/other\.test\/q3/);
});

test("a query folds case and accents, takes words in any order, and groups a select's options", () => {
  const root = parse(SNAP, "http://ir.test/x");
  const s = query(root, "cafe electrique");
  assert.equal(s.hits, 1);
  assert.match(s.lines[0], /^main \[e4\] > combobox \(label "Issuer"\) \[ref=e7\]: 42 options, selected "All"\n {4}matching options: "Café Électrique SA"$/);
  const r = query(root, "2024 report");
  assert.equal(r.partial, false);
  assert.match(r.lines[0], /^main \[e4\] > list \[e8\] > listitem \[ref=e24\]: Report 2024 PDF\n {4}link "PDF" \[ref=e44\] -> http:\/\/ir\.test\/r2024\.pdf$/);
  const p = query(root, "report 2024 dividend");
  assert.equal(p.partial, true);
  assert.equal(p.best, 2);
});

test("a combobox without options (an autocomplete field) is shown and searched like any element", () => {
  const root = parse(`- banner [ref=e2]:
  - combobox [ref=e21]:
    - textbox "代码/简称/关键字" [ref=e23]
    - button [ref=e25]
- main [ref=e30]:
  - heading "公告" [level=1] [ref=e31]`, "http://x.test/");
  assert.match(query(root, "关键字").lines[0], /textbox "代码\/简称\/关键字" \[ref=e23\]/);
  assert.doesNotMatch(outline(root), /0 options/);
});

test("a ref shows its subtree whole; target gives what an action needs", () => {
  const root = parse(SNAP, "http://ir.test/x");
  const s = subtree(root, "e8");
  assert.equal(s.path, "main [e4]");
  assert.equal(s.lines.filter((l) => l.includes("listitem")).length, 9);
  assert.deepEqual(target(root, "e44"), { role: "link", name: "PDF", url: "http://ir.test/r2024.pdf", checked: false,
    context: "Report 2024 PDF", options: null });
  assert.equal(target(root, "e7").options.length, 42);
  assert.equal(target(root, "e999"), null);
});

test("a long outline is cut, saying what was left out; long results come in pages", () => {
  const long = `- main [ref=e1]:\n${Array.from({ length: 400 }, (_, i) => `  - heading "Section ${i} of a long page" [level=2] [ref=e${i + 2}]`).join("\n")}`;
  const o = outline(parse(long, "http://x.test/"));
  assert.ok(o.length <= VIEW_CHARS + 200, "the cut line is the only line past the limit");
  assert.match(o, /… outline cut at 6000 characters: \d+ more lines; observe with a query or a ref to see them$/);
  const lines = subtree(parse(long, "http://x.test/"), "e1").lines;
  const first = paged(lines, 1);
  assert.ok(first.pages > 1);
  assert.ok(first.text.length <= VIEW_CHARS);
  const last = paged(lines, first.pages);
  assert.match(last.text, /Section 399 of a long page/);
  assert.doesNotMatch(first.text, /Section 399 of/);
  assert.equal(paged(lines, 99).page, first.pages, "a page past the end is the last page");
});
