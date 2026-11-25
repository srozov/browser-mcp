// A saved document's readable pages, prepared by code for the callers: a PDF's page texts (layout and reading
// order), page images and info, through poppler (pdftotext, pdftoppm, pdfinfo); an xlsx's sheets as page texts.
// Ported from the page readers' page helper, which was Python calling poppler: the same commands, numbering and sheet
// rules, from Node.
// Page numbers are 1-based PDF page indices (pages/0001.txt is PDF page 1), never the number printed on the page.

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { strFromU8, unzipSync } from "fflate";

const run = promisify(execFile);
const DPI = 150;
const RENDER_WORKERS = 6;

const page = (n) => String(n).padStart(4, "0");

async function poppler(command, args) {
  try {
    return (await run(command, args, { maxBuffer: 1 << 28, encoding: "utf8" })).stdout;
  } catch (error) {
    throw new Error(`PDF preparation failed: ${(error.stderr || error.message).trim()}`);
  }
}

/** pdfinfo's title, page count and creation and modification dates (as printed, or null). */
async function pdfInfo(file) {
  const fields = {};
  for (const line of (await poppler("pdfinfo", ["-isodates", file])).split("\n")) {
    const at = line.indexOf(":");
    if (at > 0) fields[line.slice(0, at).trim()] = line.slice(at + 1).trim() || null;
  }
  return { title: fields.Title ?? null, pages: Number(fields.Pages), created: fields.CreationDate ?? null, modified: fields.ModDate ?? null };
}

/** pdftotext's output (layout or reading order), one file per page in out; its page count must be pdfinfo's. */
function writeTexts(output, pages, out) {
  const texts = output.split("\f");
  if (texts.at(-1) === "") texts.pop();
  if (texts.length !== pages) throw new Error(`PDF preparation failed: pdftotext gave ${texts.length} pages, pdfinfo ${pages}`);
  mkdirSync(out, { recursive: true });
  texts.forEach((text, i) => writeFileSync(join(out, `${page(i + 1)}.txt`), text));
}

/**
 * pages/NNNN.txt (layout text), reading/NNNN.txt (reading-order text, a column's sentences kept together) and
 * pages/NNNN.png for every page of a PDF; returns its info.
 */
export async function preparePdf(file, dir) {
  const info = await pdfInfo(file);
  const out = join(dir, "pages");
  // The two passes run together; their files are written only once both have finished.
  const [layout, reading] = await Promise.all([["-layout"], []].map((flags) =>
    poppler("pdftotext", [...flags, "-enc", "UTF-8", file, "-"])));
  writeTexts(layout, info.pages, out);
  writeTexts(reading, info.pages, join(dir, "reading"));
  let next = 1;
  const worker = async () => {
    for (let n = next++; n <= info.pages; n = next++) {
      await poppler("pdftoppm", ["-r", String(DPI), "-png", "-f", String(n), "-l", String(n), "-singlefile", file, join(out, page(n))]);
    }
  };
  await Promise.all(Array.from({ length: RENDER_WORKERS }, worker));
  return info;
}

const decode = (s) => s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi, (_, hex, dec, name) =>
  hex ? String.fromCodePoint(Number.parseInt(hex, 16)) : dec ? String.fromCodePoint(Number(dec))
    : { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[name.toLowerCase()]);

// The elements and attributes the sheet rules read; a namespace prefix (x:c) is allowed.
const elements = (xml, tag) => [...xml.matchAll(new RegExp(`<(?:\\w+:)?${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:\\w+:)?${tag}>)`, "g"))]
  .map((m) => ({ attrs: m[1], body: m[2] ?? "" }));
const attr = (attrs, name) => {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
  return m ? decode(m[1]) : null;
};
const texts = (xml) => elements(xml, "t").map((t) => decode(t.body)).join("");

function column(ref) {
  let n = 0;
  for (const ch of /^[A-Z]+/.exec(ref)[0]) n = n * 26 + ch.charCodeAt(0) - 64;
  return n;
}

/**
 * [name, text] per worksheet in workbook order: one line per non-empty row, its cells' values as stored (a
 * formula's cached value, a shared string's text) joined by tabs, empty cells kept as empty fields.
 */
export function sheetTexts(bytes) {
  const zip = unzipSync(bytes);
  const read = (path) => {
    if (!zip[path]) throw new Error(`spreadsheet preparation failed: no ${path} in the workbook`);
    return strFromU8(zip[path]);
  };
  const shared = zip["xl/sharedStrings.xml"] ? elements(read("xl/sharedStrings.xml"), "si").map((si) => texts(si.body)) : [];
  const rels = Object.fromEntries(elements(read("xl/_rels/workbook.xml.rels"), "Relationship").map((r) => [attr(r.attrs, "Id"), attr(r.attrs, "Target")]));
  return elements(read("xl/workbook.xml"), "sheet").map((sheet) => {
    const target = rels[attr(sheet.attrs, "r:id")];
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    const lines = [];
    for (const row of elements(read(path), "row")) {
      const cells = new Map();
      for (const c of elements(row.body, "c")) {
        const kind = attr(c.attrs, "t");
        const v = elements(c.body, "v")[0];
        let value;
        if (kind === "inlineStr") value = texts(c.body);
        else if (!v) continue;
        else value = kind === "s" ? shared[Number(v.body)] : decode(v.body);
        if (value.trim()) cells.set(column(attr(c.attrs, "r")), value.trim());
      }
      if (!cells.size) continue;
      const cols = [...cells.keys()];
      const [first, last] = [Math.min(...cols), Math.max(...cols)];
      lines.push(Array.from({ length: last - first + 1 }, (_, i) => cells.get(first + i) ?? "").join("\t"));
    }
    return [attr(sheet.attrs, "name"), lines.join("\n")];
  });
}

/** pages/NNNN.txt per worksheet, its name on the first line ("Sheet: <name>"); returns the sheet count and names. */
export function sheets(file, dir) {
  const all = sheetTexts(readFileSync(file));
  mkdirSync(join(dir, "pages"), { recursive: true });
  all.forEach(([name, text], i) => writeFileSync(join(dir, "pages", `${page(i + 1)}.txt`), `Sheet: ${name}\n${text}\n`));
  return { pages: all.length, sheets: all.map(([name]) => name) };
}
