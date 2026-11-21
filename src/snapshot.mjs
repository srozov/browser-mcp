// The browse tool's page model, moved from the page readers' browser server: Playwright's ARIA snapshot for AI
// (`page._snapshotForAI()`, the model behind Playwright MCP's browser_snapshot), parsed into a tree and shown in
// three bounded views: an outline of the page, the lines that match a query (with their ancestor path), and one
// subtree. Pure functions over the snapshot text; browse.mjs takes the snapshot and acts on `aria-ref=eN`.
//
// The snapshot is a private Playwright API: patchright is pinned in package.json, and
// snapshot.test.mjs fails when the format the parser reads changes.

export const VIEW_CHARS = 6000;
const NAME_CHARS = 120;
const ITEMS_SHOWN = 3; // items of a long list or table shown in the outline
const LONG = 6; // a list or table with more items than this is collapsed in the outline
const OPTIONS_SHOWN = 10;
const LINKS_SHOWN = 3; // links shown under a query hit that holds them

const LANDMARKS = new Set(["banner", "navigation", "main", "contentinfo", "complementary", "region", "form", "search", "dialog", "alertdialog"]);
const COLLAPSED = new Set(["navigation", "banner", "contentinfo"]);
const LISTS = new Set(["list", "menu", "menubar", "tree", "tablist", "listbox"]);
const TABLES = new Set(["table", "grid", "treegrid"]);
const CHOICES = new Set(["combobox", "listbox"]);
const CONTROLS = new Set(["textbox", "searchbox", "spinbutton", "combobox", "checkbox", "radio", "switch", "slider"]);
const STATES = ["checked", "selected", "expanded", "pressed", "disabled", "level", "active"];

// Zero-width characters, and the private-use code points icon fonts draw glyphs with.
const INVISIBLE = /[​-‍⁠﻿-]/g;
const URL_CHARS = 200; // a URL longer than this is cut in the outline; query and ref views show it whole
const KEY = /^(\S+?)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]*\])*)(?::(?: (.*))?)?$/;

function unquote(value) {
  if (value === undefined) return "";
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

/** A link's URL made absolute against the page (a register's notice links are "#/notice/…"). */
function absolute(url, base) {
  try {
    return base ? new URL(url, base).href : url;
  } catch {
    return url;
  }
}

/**
 * Parse the snapshot text into a tree of {role, name, ref, attrs, text, url, placeholder, children,
 * parent}; link URLs are made absolute against `base`, the page's URL.
 */
export function parse(snapshot, base = null) {
  const root = { role: "page", name: "", attrs: {}, text: "", children: [], parent: null, depth: -1 };
  const stack = [root];
  for (const raw of snapshot.split("\n")) {
    const m = /^(\s*)- (.*)$/.exec(raw);
    if (!m) continue;
    const depth = m[1].length / 2;
    let body = m[2];
    // A key YAML had to quote: - 'link "a: b" [ref=e1]': value
    if (body.startsWith("'")) {
      let close = -1;
      for (let i = 1; i < body.length && close < 0; i++) {
        if (body[i] === "'" && body[i + 1] === "'") i++;
        else if (body[i] === "'") close = i;
      }
      if (close > 0) body = body.slice(1, close).replace(/''/g, "'") + body.slice(close + 1);
    }
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
    const parent = stack[stack.length - 1];
    if (body.startsWith("/url:")) {
      parent.url = absolute(unquote(body.slice(5).trim()), base);
      continue;
    }
    if (body.startsWith("/placeholder:")) {
      parent.placeholder = unquote(body.slice(13).trim());
      continue;
    }
    if (body.startsWith("/")) continue; // other properties the views do not use
    const k = KEY.exec(body);
    if (!k) throw new Error(`snapshot line not understood: ${raw.trim().slice(0, 120)}`);
    const attrs = {};
    for (const a of (k[3] || "").matchAll(/\[([^\]=]+)(?:=([^\]]*))?\]/g)) attrs[a[1]] = a[2] ?? true;
    const node = {
      role: k[1], name: k[2] !== undefined ? unquote(`"${k[2]}"`).replace(INVISIBLE, "").trim() : "", ref: attrs.ref || null, attrs,
      text: unquote(k[4]).replace(INVISIBLE, "").trim(), children: [], parent, depth,
    };
    parent.children.push(node);
    stack.push(node);
  }
  return root;
}

/** Wrappers that carry nothing (an unnamed generic or group without text, ref-only) give way to their children. */
function transparent(node) {
  return (node.role === "generic" || node.role === "group" || node.role === "none" || node.role === "presentation")
    && !node.name && !node.text && !node.attrs.cursor && !node.url;
}

const INTERACTIVE = new Set(["link", "button", "tab", "menuitem", "option", ...CONTROLS]);
const CELLS = new Set(["cell", "gridcell", "columnheader", "rowheader", "listitem"]);

/**
 * The children as shown: transparent wrappers flattened; dropped are unnamed images, empty leaves (an
 * empty paragraph, an icon glyph) and leaves that only repeat their parent's name (a link's own text).
 */
export function shown(node) {
  const out = [];
  for (const c of node.children) {
    if (c.role === "img" && !c.name) continue;
    if (transparent(c)) {
      out.push(...shown(c));
      continue;
    }
    if (!c.children.length && !INTERACTIVE.has(c.role) && !c.url) {
      const own = c.name || c.text;
      if (!own && !c.attrs.cursor) continue;
      if (own && node.name && node.name.includes(own) && !CELLS.has(c.role)) continue;
    }
    out.push(c);
  }
  return out;
}

const clip = (s, n = NAME_CHARS) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** All text in a subtree, in order (names, texts), as one line. */
export function textOf(node, limit = 300) {
  const parts = [];
  const walk = (n) => {
    if (parts.join(" ").length > limit) return;
    if (n.name) parts.push(n.name);
    else if (n.text) parts.push(n.text);
    if (!n.name) for (const c of n.children) walk(c);
  };
  walk(node);
  return clip(parts.join(" ").replace(/\s+/g, " ").trim(), limit);
}

/** An unnamed control is labelled by the text just before it (a register's "Issuer" then its combobox). */
export function labelOf(node) {
  if (node.name || !CONTROLS.has(node.role) || !node.parent) return "";
  const siblings = shown(node.parent);
  const i = siblings.indexOf(node);
  const before = siblings[i - 1];
  if (before && !CONTROLS.has(before.role) && before.role !== "button" && before.role !== "link") {
    const t = textOf(before, 60);
    if (/\p{L}/u.test(t) && t.length <= 60) return t;
  }
  return "";
}

const options = (node) => {
  const out = [];
  const walk = (n) => {
    for (const c of n.children) {
      if (c.role === "option") out.push(c);
      else walk(c);
    }
  };
  walk(node);
  return out;
};

// A combobox with options is a select (shown by its size and selection); one without (an
// autocomplete search field: a combobox holding a textbox) is shown and searched like any element.
const isChoice = (node) => CHOICES.has(node.role) && options(node).length > 0;

const count = (node, role) => {
  let n = 0;
  const walk = (x) => {
    for (const c of x.children) {
      if (c.role === role) n++;
      else walk(c);
    }
  };
  walk(node);
  return n;
};

/** One node as one line: role "name" (label) [states] [ref]: text -> url. */
export function line(node, { blocked = () => null, short = false } = {}) {
  const parts = [node.role];
  if (node.name) parts.push(JSON.stringify(clip(node.name)));
  const label = labelOf(node);
  if (label) parts.push(`(label ${JSON.stringify(label)})`);
  for (const s of STATES) if (node.attrs[s] !== undefined) parts.push(node.attrs[s] === true ? `[${s}]` : `[${s}=${node.attrs[s]}]`);
  if (node.role === "generic" && node.attrs.cursor === "pointer") parts.push("[clickable]");
  if (node.ref) parts.push(`[ref=${node.ref}]`);
  let out = parts.join(" ");
  if (node.placeholder) out += ` placeholder=${JSON.stringify(clip(node.placeholder, 60))}`;
  if (node.text) out += `: ${clip(node.text, 200)}`;
  if (node.url) {
    const url = node.url.replace(/\s+/g, " ");
    out += ` -> ${short ? clip(url, URL_CHARS) : url}`;
    const reason = blocked(node.url);
    if (reason) out += ` (blocked: ${reason})`;
  }
  return out;
}

/** A combobox or listbox as one line: its size and selection, never all its options. */
function choiceLine(node, opts) {
  const all = options(node);
  const selected = all.filter((o) => o.attrs.selected).map((o) => JSON.stringify(clip(o.name, 60)));
  return `${line(node, opts)}: ${all.length} options${selected.length ? `, selected ${selected.join(", ")}` : ""}`;
}

function itemsOf(node) {
  if (TABLES.has(node.role)) {
    const rows = [];
    const walk = (x) => {
      for (const c of x.children) (c.role === "row" ? rows.push(c) : walk(c));
    };
    walk(node);
    return { items: rows, noun: "rows" };
  }
  return { items: shown(node), noun: "items" };
}

/**
 * The outline: the page's structure with long parts collapsed. Navigation, header and footer become
 * one line; a combobox shows its size and selection; a list or table longer than LONG shows its first
 * ITEMS_SHOWN items and how many more there are. Cut at VIEW_CHARS, saying what was left out.
 */
export function outline(root, opts = {}) {
  opts = { ...opts, short: true };
  const lines = [];
  const emit = (node, indent) => {
    const pad = "  ".repeat(indent);
    if (isChoice(node)) return lines.push(pad + choiceLine(node, opts));
    if (COLLAPSED.has(node.role)) {
      const links = count(node, "link");
      const more = node.ref ? `observe ref ${node.ref} to expand` : "observe with a query to search it";
      return lines.push(`${pad}${line(node, opts)}: ${links} links (${clip(textOf(node, 160), 160)}); ${more}`);
    }
    if (node.role === "row") return lines.push(pad + line({ ...node, children: [] }, opts));
    lines.push(pad + line(node, opts));
    if (TABLES.has(node.role) || LISTS.has(node.role)) {
      const { items, noun } = itemsOf(node);
      if (items.length > LONG) {
        for (const item of items.slice(0, ITEMS_SHOWN)) emit(item, indent + 1);
        const more = node.ref ? `observe ref ${node.ref} to see them` : "observe with a query to find them";
        lines.push(`${pad}  … ${items.length - ITEMS_SHOWN} more ${noun} (${items.length} in all); ${more}`);
        return;
      }
    }
    for (const c of shown(node)) emit(c, indent + 1);
  };
  for (const c of shown(root)) emit(c, 0);
  return cut(lines, "outline");
}

function cut(lines, what) {
  const out = [];
  let size = 0;
  for (const [i, l] of lines.entries()) {
    if (size + l.length + 1 > VIEW_CHARS) {
      out.push(`… ${what} cut at ${VIEW_CHARS} characters: ${lines.length - i} more lines; observe with a query or a ref to see them`);
      break;
    }
    out.push(l);
    size += l.length + 1;
  }
  return out.join("\n");
}

/** Pages of at most VIEW_CHARS characters, split at line ends. */
export function paged(lines, n) {
  const pages = [[]];
  let size = 0;
  for (const l of lines) {
    if (size + l.length + 1 > VIEW_CHARS && pages[pages.length - 1].length) {
      pages.push([]);
      size = 0;
    }
    pages[pages.length - 1].push(l);
    size += l.length + 1;
  }
  const page = Math.min(Math.max(1, n || 1), pages.length);
  return { page, pages: pages.length, text: pages[page - 1].join("\n") };
}

export function find(root, ref) {
  let hit = null;
  const walk = (n) => {
    if (hit) return;
    if (n.ref === ref) hit = n;
    else n.children.forEach(walk);
  };
  walk(root);
  return hit;
}

/** One subtree in full (wrappers flattened), with its ancestor path on top. */
export function subtree(root, ref, opts = {}) {
  const node = find(root, ref);
  if (!node) return null;
  const lines = [];
  const emit = (n, indent) => {
    lines.push("  ".repeat(indent) + line(n, opts));
    for (const c of shown(n)) emit(c, indent + 1);
  };
  emit(node, 0);
  return { path: path(node), lines };
}

/** The ancestors that orient a hit: landmarks, tables, lists, rows and named containers. */
export function path(node) {
  const parts = [];
  for (let a = node.parent; a && a.role !== "page"; a = a.parent) {
    if (transparent(a) || a.role === "generic" && !a.name) continue;
    if (LANDMARKS.has(a.role) || TABLES.has(a.role) || LISTS.has(a.role) || a.role === "row" || a.role === "listitem" || a.name) {
      parts.unshift(`${a.role}${a.name ? ` "${clip(a.name, 40)}"` : ""}${a.ref ? ` [${a.ref}]` : ""}`);
    }
  }
  return parts.join(" > ");
}

/**
 * The lines matching a query: case and accents folded, every word of the query in the line in any
 * order; when no line has them all, the lines with the most of them, said so. Options of a combobox are
 * grouped under it (its ref, the matching options), never all of them.
 */
export function query(root, q, opts = {}) {
  const words = fold(q).split(/\s+/).filter(Boolean);
  const scored = [];
  const seen = new Map(); // node -> its entry: a text without a ref counts for the element holding it
  const hit = (matched, score) => {
    let node = matched;
    while (!node.ref && node.parent && node.parent.role !== "page") node = node.parent;
    // A cell counts as its row: the row holds the links an agent acts on (a filing index's "Documents").
    if (["cell", "gridcell", "rowheader"].includes(node.role)) {
      let row = node.parent;
      while (row && row.role !== "row") row = row.parent;
      if (row?.ref) node = row;
    }
    let entry = seen.get(node);
    if (!entry) {
      entry = { node, score, inner: [] };
      seen.set(node, entry);
      scored.push(entry);
    }
    entry.score = Math.max(entry.score, score);
    // A matched element without a ref (a disabled field, a bare text) is shown under its holder.
    if (matched !== node && matched.role !== "text" && !CELLS.has(matched.role)) entry.inner.push(matched);
  };
  const walk = (n) => {
    for (const c of n.children) {
      if (c.role !== "option" && !transparent(c)) {
        const hay = fold(`${line(c)} ${labelOf(c)}`);
        const score = words.filter((w) => hay.includes(w)).length;
        if (score) hit(c, score);
      }
      if (isChoice(c)) {
        const hits = options(c).filter((o) => words.every((w) => fold(o.name).includes(w)));
        if (hits.length) scored.push({ node: c, score: words.length, options: hits, inner: [] });
      } else walk(c);
    }
  };
  walk(root);
  const best = Math.max(0, ...scored.map((s) => s.score));
  // A hit inside another hit (a row's cell) adds nothing to the outer hit's line, unless it is a
  // control or link of its own (a checkbox inside its clickable label).
  const top = new Set(scored.filter((s) => s.score === best).map((s) => s.node));
  const inside = (n) => {
    if (INTERACTIVE.has(n.role)) return false;
    for (let a = n.parent; a; a = a.parent) if (top.has(a)) return true;
    return false;
  };
  const hits = scored.filter((s) => s.score === best && !inside(s.node));
  const lines = [];
  for (const h of hits) {
    const where = path(h.node);
    let l = `${where ? `${where} > ` : ""}${h.options ? choiceLine(h.node, opts) : line(h.node, opts)}`;
    if (h.options) {
      const shownOpts = h.options.slice(0, OPTIONS_SHOWN).map((o) => JSON.stringify(o.name)).join(" | ");
      l += `\n    matching options: ${shownOpts}${h.options.length > OPTIONS_SHOWN ? ` (+${h.options.length - OPTIONS_SHOWN} more; use more words)` : ""}`;
    } else if (["row", "listitem", "cell", "gridcell", "paragraph"].includes(h.node.role) && !h.node.name && !h.node.text) {
      l += `: ${textOf(h.node, 200)}`;
    }
    for (const m of h.inner.slice(0, OPTIONS_SHOWN)) l += `\n    ${line(m, opts)}`;
    // A hit row or item shows the links inside it: the ref to click is often there (a register's detail link).
    if (h.node.role !== "link") {
      const links = [];
      const walk = (n) => n.children.forEach((c) => (c.role === "link" ? links.push(c) : walk(c)));
      walk(h.node);
      for (const k of links.filter((x) => !top.has(x)).slice(0, LINKS_SHOWN)) l += `\n    ${line(k, opts)}`;
      if (links.length > LINKS_SHOWN) l += `\n    (+${links.length - LINKS_SHOWN} more links; observe ref ${h.node.ref ?? "?"})`;
    }
    lines.push(l);
  }
  const partial = best > 0 && best < words.length;
  return { hits: hits.length, partial, best, words: words.length, lines };
}

/**
 * What an action changed in place: the lines that appeared (shown with their refs) and how many
 * disappeared, compared without refs and focus. A select counts by its selection, not its options.
 */
export function diff(before, after, opts = {}) {
  const flat = (root) => {
    const out = [];
    const walk = (n) => {
      for (const c of shown(n)) {
        out.push(c);
        if (!isChoice(c)) walk(c);
      }
    };
    walk(root);
    return out;
  };
  const key = (n) => (isChoice(n) ? choiceLine(n) : line(n)).replace(/ \[(ref=[^\]]+|active)\]/g, "");
  const left = new Map();
  for (const n of flat(before)) left.set(key(n), (left.get(key(n)) ?? 0) + 1);
  const added = [];
  for (const n of flat(after)) {
    const k = key(n);
    if (left.get(k)) left.set(k, left.get(k) - 1);
    else added.push(isChoice(n) ? choiceLine(n, opts) : line(n, opts));
  }
  return { added, removed: [...left.values()].reduce((a, b) => a + b, 0) };
}

/** What an action needs to act on a ref: its role, name, URL, state and the text around it. */
export function target(root, ref) {
  const node = find(root, ref);
  if (!node) return null;
  let around = null;
  for (let a = node.parent; a && a.role !== "page"; a = a.parent) {
    if (["listitem", "row", "paragraph", "article", "cell", "gridcell", "region"].includes(a.role)) {
      around = textOf(a, 160);
      break;
    }
  }
  // Else the nearest wrapper that adds text to the link (a report list's "Half-year report" beside "First
  // half of 2025"), when it is short enough to be about this link alone.
  const own = node.name || textOf(node, 120);
  for (let a = node.parent; !around && a && a.role !== "page"; a = a.parent) {
    const t = textOf(a, 400);
    if (t.length > own.length + 8) {
      around = t.length <= 160 ? t : null;
      break;
    }
  }
  return {
    role: node.role, name: node.name || textOf(node, 120), url: node.url || null, checked: node.attrs.checked !== undefined,
    context: around && around !== node.name ? around : null, options: CHOICES.has(node.role) ? options(node).map((o) => o.name) : null,
  };
}
