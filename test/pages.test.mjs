// The page texts, page images and info of a PDF (poppler), and the sheet texts of an xlsx, without a daemon.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { preparePdf, sheets, sheetTexts } from "../src/pages.mjs";
import { FIGURES, pdf, xlsx } from "./fixture-site.mjs";

const dir = mkdtempSync(join(tmpdir(), "browser-mcp-pages-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("a PDF gets one text and one image per page, numbered by PDF page, with its title and dates", async () => {
  const file = join(dir, "a.pdf");
  writeFileSync(file, pdf([["First page"], ["Second page", "Operating profit 210.5"]], { Title: "Report (draft)", CreationDate: "D:20260302090000Z" }));
  const info = await preparePdf(file, dir);
  assert.deepEqual(info, { title: "Report (draft)", pages: 2, created: "2026-03-02T09:00:00Z", modified: null });
  assert.match(readFileSync(join(dir, "pages", "0002.txt"), "utf8"), /Operating profit 210\.5/);
  assert.doesNotMatch(readFileSync(join(dir, "pages", "0001.txt"), "utf8"), /Operating profit/);
  for (const n of ["0001", "0002"]) assert.equal(readFileSync(join(dir, "pages", `${n}.png`)).subarray(1, 4).toString(), "PNG");
  assert.ok(!existsSync(join(dir, "pages", "0003.txt")));
});

test("a file that is not a PDF fails with poppler's reason", async () => {
  const file = join(dir, "bad.pdf");
  writeFileSync(file, "<html>viewer</html>");
  await assert.rejects(preparePdf(file, join(dir, "bad")), /PDF preparation failed: .+/);
});

test("an xlsx gives one page per sheet in workbook order, with cached values, inline strings and gaps", () => {
  const out = join(dir, "x");
  assert.deepEqual(sheets(writeTo(join(dir, "f.xlsx"), FIGURES), out), { pages: 3, sheets: ["Income statement", "Share data", "Notes"] });
  assert.equal(readFileSync(join(out, "pages", "0001.txt"), "utf8"),
    "Sheet: Income statement\nin CHF million\t2025\t2024\nRevenue\t1250\t1190\nOperating profit\t210.5\t180.2\n");
  assert.equal(readFileSync(join(out, "pages", "0002.txt"), "utf8"),
    "Sheet: Share data\nShares outstanding\t\t74500000\nTreasury shares & own shares\t\t1500000\n");
  assert.equal(readFileSync(join(out, "pages", "0003.txt"), "utf8"), "Sheet: Notes\nFigures are unaudited\n");
});

test("empty rows and blank cells are left out; a row keeps its gaps between its first and last value", () => {
  const [[name, text]] = sheetTexts(xlsx([["One", [[null, "a", null, "b"], [], ["  "], [null, null, 7]]]]));
  assert.equal(name, "One");
  assert.equal(text, "a\t\tb\n7");
});

function writeTo(file, bytes) {
  writeFileSync(file, bytes);
  return file;
}
