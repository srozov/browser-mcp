// A synthetic issuer "internet" behind a local forward proxy, for the offline tests (BROWSER_TEST_PROXY).
// Hosts: ir.issuer.test (the issuer), cdn.shared.test (a shared document CDN), and third parties. All
// names and figures are invented. 10.9.9.9 stands for a private host: the browser must never reach it,
// so the proxy must never log it. TEST_HOSTS is the DNS of the tests: every host maps to the documentation address
// 203.0.113.10, except rebind.test (127.0.0.1) and inside.test (10.9.9.9), which are public names that resolve
// to private addresses; nowhere.test does not resolve.
//
// The annual report has no share count; the results presentation on the issuer's own site does, and so
// does an older notice in a register.

import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";

/** A minimal PDF: one page per array of text lines. */
export function pdf(pages) {
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", null];
  const kids = [];
  for (const lines of pages) {
    const page = objs.length + 1;
    kids.push(`${page} 0 R`);
    const body = lines.map((l, i) => `BT /F1 10 Tf 30 ${560 - 16 * i} Td (${l.replace(/[()\\]/g, "\\$&")}) Tj ET`).join("\n");
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 600] /Contents ${page + 1} 0 R /Resources << /Font << /F1 FONT 0 R >> >> >>`);
    objs.push(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
  }
  const font = objs.length + 1;
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  objs[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body.replace("FONT", String(font))}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const AR_2025 = pdf([
  ["Example Widgets AG", "Annual Report 2025"],
  ["Consolidated income statement", "in CHF million 2025 2024", "Revenue 1,250.0 1,190.0",
    "Operating profit 210.5 180.2", "Net profit 150.1 120.0",
    "Basic and diluted earnings per registered share in CHF 3.10 2.48"],
  ["Consolidated balance sheet", "in CHF million 31 December 2025 31 December 2024",
    "Cash and cash equivalents 320.0 300.0", "Current financial liabilities 40.0 35.0",
    "Current lease liabilities 12.0 11.0", "Non-current financial liabilities 600.0 640.0",
    "Non-current lease liabilities 88.0 90.0", "Equity attributable to shareholders 1,900.0 1,820.0"],
  ["Note 18 Financial liabilities", "in CHF million 31 December 2025", "Bonds 500.0", "Bank loans 120.0",
    "Derivative financial instruments 20.0", "Total financial liabilities 640.0"],
  ["Consolidated cash flow statement", "in CHF million 2025 2024",
    "Net cash from operating activities 330.0 300.0", "Purchase of property, plant and equipment (95.0) (90.0)",
    "Purchase of intangible assets (25.0) (20.0)", "Acquisition of subsidiaries (40.0) -"],
  ["Proposed appropriation", "The Board of Directors proposes a dividend for 2025 of CHF 1.80",
    "per registered share (2024: CHF 1.60).", "Share capital: see the results presentation for share data."],
]);

const AR_2024 = pdf([["Example Widgets AG", "Annual Report 2024"], ["Consolidated income statement",
  "in CHF million 2024 2023", "Operating profit 180.2 170.0"]]);

const PRESENTATION = pdf([
  ["Example Widgets AG", "Full-year results 2025, investor presentation"],
  ["Share data at 31 December 2025", "Registered shares issued 76,000,000",
    "Treasury shares 1,500,000", "Shares outstanding 74,500,000"],
]);

export const TEST_HOSTS = {
  ...Object.fromEntries(["ir.issuer.test", "cdn.shared.test", "widget.thirdparty.test", "api.thirdparty.test", "portal.thirdparty.test",
    "ws.thirdparty.test", "evil.test", "filings.regulator.test", "register.exchange.test", "bucket.storage.test"]
    .map((host) => [host, ["203.0.113.10"]])),
  "rebind.test": ["127.0.0.1"],
  "inside.test": ["10.9.9.9"],
};

const ISSUER = "http://ir.issuer.test";

const PAGES = {
  "ir.issuer.test/date-search": `<html><body><main><h1>Disclosure search</h1>
    <form onsubmit="event.preventDefault();document.getElementById('answer').innerText='No matching notices'">
      <fieldset><legend>From</legend>
        <label>Year<input type="number" value="2026"></label>
        <label>Month<input type="number" value="12"></label>
        <label>Day<input type="number" value="31"></label>
      </fieldset><button type="submit">Search</button></form>
    <p id="answer"></p><table><tr><th>Security</th><th>Quantity</th></tr>
    <tr><td>Registered shares</td><td>1,500,000</td></tr></table>
    </main></body></html>`,
  "ir.issuer.test/investors": `<html><head><title>Investors</title></head><body><main><h1>Investors</h1>
    <p>Issuer results text. Example Widgets AG investor relations.</p>
    <ul>
      <li><a href="/reports">Reports</a></li>
      <li><a href="/presentations">Presentations</a></li>
      <li><a href="/redirect-out">Results centre</a></li>
      <li><a href="http://portal.thirdparty.test/issuer">Share price and key figures at a portal</a></li>
      <li><a href="/reports" onclick="event.preventDefault(); setTimeout(() => { location.href = '/reports'; }, 500)">Late reports link</a></li>
      <li><a href="#" onclick="event.preventDefault(); setTimeout(() => window.open('/files/fy2025-presentation.pdf'), 500)">Presentation.pdf</a></li>
    </ul>
    <button id="js" onclick="location.href='http://10.9.9.9/js'">Open archive</button>
    <button id="pop" onclick="window.open('http://10.9.9.9/popup')">Open viewer</button>
    <button id="tab" onclick="window.open('/reports')">Reports in a new tab</button>
    <iframe src="http://widget.thirdparty.test/quote"></iframe>
    <script>fetch('http://api.thirdparty.test/quote').then(r => r.text()).then(t => document.body.insertAdjacentHTML('beforeend', '<p>'+t+'</p>')).catch(() => {});</script>
    <script>fetch('http://10.9.9.9/data').catch(() => {});</script>
    </main></body></html>`,
  "ir.issuer.test/hang": `<html><head><title>Hang</title></head><body><main><p>A page whose script never yields.</p>
    <script>setTimeout(() => { for (;;) {} }, 300);</script></main></body></html>`,
  "ir.issuer.test/reports": `<html><head><title>Reports</title></head><body><main><h1>Reports</h1><p>Report archive</p>
    <select id="year"><option>2026</option><option>2025</option></select>
    <ul>
      <li>2025 Annual Report (published 3 March 2026) <a href="http://cdn.shared.test/space1/ar-2025.pdf">Download pdf</a></li>
      <li>2024 Annual Report (published 4 March 2025) <a href="http://cdn.shared.test/space1/ar-2024.pdf">Download pdf</a></li>
      <li>Moved report <a href="http://cdn.shared.test/space1/moved.pdf">Download pdf</a></li>
      <li><a href="/files/q.pdf" download>Quarterly results</a></li>
      <li><a href="/files/via-storage">Capital structure</a></li>
    </ul></main></body></html>`,
  "ir.issuer.test/presentations": `<html><head><title>Presentations</title></head><body><main><h1>Presentations</h1>
    <button onclick="setTimeout(() => { location.href = '/files/q.pdf'; }, 2500)">Download announcement</button>
    <ul><li>Full-year results 2025 presentation (3 March 2026) <a href="/files/fy2025-presentation.pdf">PDF</a></li></ul>
    </main></body></html>`,
  // A register: a long issuer list behind a label, a styled checkbox (its input hidden in
  // its label, which stays above the banner) that keeps only current notices, a plain checkbox the banner covers,
  // a from-date in parts (year, month, day), a Search button whose results load late, a detail view per notice,
  // and a consent banner over it all.
  "register.exchange.test/notices": `<html><head><title>Notices</title>
    <style>.cb { position: relative; } .cb input { opacity: 0; position: absolute; left: 0; top: 0; }
      .cb span { position: relative; z-index: 1; padding-left: 20px; cursor: pointer; }</style></head>
    <body><main><h1>Notices</h1>
    <form id="filter">
      <div><span>ISSUER</span><select id="who"><option>All</option>
        ${Array.from({ length: 60 }, (_, i) => `<option>Issuer ${String(i).padStart(2, "0")} AG</option>`).join("")}
        <option>Example Widgets AG</option></select></div>
      <fieldset><legend>From</legend>
        <label>Year<input type="number" id="from-year" value="2026"></label>
        <label>Month<input type="number" id="from-month" value="1"></label>
        <label>Day<input type="number" id="from-day" value="1"></label></fieldset>
      <label class="cb" for="current"><input type="checkbox" id="current" readonly checked><span>Current notices only</span></label>
      <label><input type="checkbox" id="archived"> Include archived</label>
      <button type="submit">Search</button></form>
    <table><caption>Results</caption><tbody id="out"></tbody></table>
    <section id="detail" aria-label="Notice detail"></section></main>
    <div id="consent-banner" style="position:fixed;inset:0;background:rgba(0,0,0,.4)">
      <button onclick="document.getElementById('consent-banner').remove()">Accept All Cookies</button></div>
    <script>
      const notices = [
        { id: "N1", issuer: "Example Widgets AG", date: "2025-09-03", current: false, text: "Example Widgets AG holds own shares 1,500,000 (2.0%), transaction 2025-08-27" },
        { id: "N2", issuer: "Example Widgets AG", date: "2026-09-15", current: true, text: "Fund Manager Ltd holds 3.1%" },
        { id: "N3", issuer: "Issuer 07 AG", date: "2026-09-10", current: true, text: "Issuer 07 AG holds own shares 10" },
      ];
      document.getElementById("filter").onsubmit = (event) => {
        event.preventDefault();
        const who = document.getElementById("who").value;
        const from = ["year", "month", "day"].map((part) => document.getElementById("from-" + part).value.padStart(2, "0")).join("-");
        const current = document.getElementById("current").checked;
        const hits = notices.filter((n) => (who === "All" || n.issuer === who) && (!current || n.current) && n.date >= from);
        setTimeout(() => {
          document.getElementById("out").innerHTML = hits.map((n) => '<tr><td>' + n.date + '</td><td>' + n.issuer +
            '</td><td><a href="#/notice/' + n.id + '">Details</a></td></tr>').join("") || '<tr><td>No results</td></tr>';
        }, 700);
      };
      window.onhashchange = () => {
        const n = notices.find((x) => location.hash === "#/notice/" + x.id);
        document.getElementById("detail").innerHTML = n ? "<h2>Notice " + n.id + "</h2><p>" + n.text + "</p>" : "";
      };
    </script>
    </body></html>`,
  "ir.issuer.test/policy": `<html><head><title>Policy</title></head><body><main><p>POLICY PAGE</p>
    <script>for (const host of ["rebind.test", "inside.test", "nowhere.test"]) fetch("http://" + host + "/data").catch(() => {});</script>
    </main></body></html>`,
  "ir.issuer.test/sockets": `<html><head><title>Sockets</title></head><body><main><p>SOCKETS PAGE</p>
    <script>for (const host of ["ws.thirdparty.test", "10.9.9.9", "rebind.test"]) {
      const say = (what) => document.querySelector("main").insertAdjacentHTML("beforeend", "<p>WS " + host + " " + what + "</p>");
      const socket = new WebSocket("ws://" + host + "/feed");
      socket.onopen = () => say("OPEN");
      socket.onmessage = (event) => say("MESSAGE " + event.data);
      socket.onerror = () => say("ERROR");
    }</script></main></body></html>`,
  "widget.thirdparty.test/quote": "<p>THIRD PARTY QUOTE 123.45</p>",
  "evil.test/js": "<p>EVIL JS TARGET</p>",
  "evil.test/popup": "<p>EVIL POPUP</p>",
  "evil.test/landing": "<p>EVIL LANDING</p>",
  "portal.thirdparty.test/issuer": "<p>PORTAL FIGURES operating profit 999.9, shares 99,999,999</p>",
};

const FILES = {
  "cdn.shared.test/space1/ar-2025.pdf": [AR_2025, "Tue, 03 Mar 2026 06:30:00 GMT"],
  "cdn.shared.test/space1/ar-2024.pdf": [AR_2024, "Tue, 04 Mar 2025 06:30:00 GMT"],
  "cdn.shared.test/space2/other.pdf": [pdf([["another company"]]), null],
  // A real PDF behind a few junk bytes (readers accept the header within the first 1024 bytes), and an
  // HTML page served as a PDF.
  "cdn.shared.test/space2/prefixed.pdf": [Buffer.concat([Buffer.from("\r\n\r\n"), pdf([["Prefixed report 42.0"]])]), null],
  "cdn.shared.test/space2/not-a.pdf": [Buffer.from("<!doctype html><html><body>viewer</body></html>"), null],
  "ir.issuer.test/files/fy2025-presentation.pdf": [PRESENTATION, "Tue, 03 Mar 2026 06:30:00 GMT"],
  "ir.issuer.test/files/q.pdf": [pdf([["Quarter 7.40"]]), null, "attachment; filename=q.pdf"],
  "bucket.storage.test/capital.pdf": [pdf([["Capital structure", "Registered shares issued 76,000,000"]]), null],
};

/** Start the proxy on 127.0.0.1; returns {server, url, hits}. */
export async function startFixtureSite(port = 0) {
  const hits = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const key = `${url.host}${url.pathname}`;
    hits.push(key);
    if (key === "api.thirdparty.test/quote") return res.end("THIRD PARTY API 99.9");
    // A regulator that refuses scripted clients: a client that is not the browser gets 403 (a navigation asks for
    // text/html, a page's own fetch sends its referer; Playwright's request client does neither).
    if (url.host === "filings.regulator.test" && !String(req.headers.accept).includes("text/html") && !req.headers.referer) {
      return res.writeHead(403).end("forbidden");
    }
    if (key === "filings.regulator.test/q2.htm") {
      return res.writeHead(200, { "content-type": "text/html" }).end("<html><head><title>Quarterly filing</title></head><body><p>FORM QUARTERLY</p><p>Net sales 154,944</p></body></html>");
    }
    // A page whose image cannot be taken in time: a font it adds after load never arrives, and a page
    // screenshot waits for fonts (as a very long page outran the screenshot limit).
    if (key === "filings.regulator.test/long-20f.htm") {
      return res.writeHead(200, { "content-type": "text/html" }).end(`<html><head><title>Annual filing</title></head><body>
        <p>FORM ANNUAL</p><p>Operating profit 128,339</p><script>addEventListener("load", () => {
        const f = new FontFace("Slow", "url(/fonts/slow.woff2)"); document.fonts.add(f); f.load().catch(() => {}); });</script>
        </body></html>`);
    }
    // A page too tall for a full-page image (a combined report can be 410,000 px).
    if (key === "filings.regulator.test/tall-ncsr.htm") {
      return res.writeHead(200, { "content-type": "text/html" }).end(
        '<html><head><title>Combined filing</title></head><body><p>FORM COMBINED</p><p>Net assets 9,876,543</p><div style="height:50000px"></div></body></html>');
    }
    if (key === "filings.regulator.test/fonts/slow.woff2") {
      return setTimeout(() => { if (!res.destroyed) res.writeHead(404).end(); }, 10_000).unref();
    }
    if (key === "filings.regulator.test/ix") {
      return res.writeHead(200, { "content-type": "text/html" }).end(
        '<html><head><title>Inline Viewer</title></head><body><iframe src="/q2.htm" style="border:0"></iframe></body></html>');
    }
    if (key === "filings.regulator.test/ex99.pdf") {
      return res.writeHead(200, { "content-type": "application/pdf" }).end(pdf([["Exhibit 99.1", "Operating profit 72,240"]]));
    }
    if (key === "ir.issuer.test/set-cookie") {
      const value = url.searchParams.get("v") ?? "";
      // Persistent (Max-Age): a session cookie would not survive a browser relaunch.
      return res.writeHead(200, { "content-type": "text/html", "set-cookie": `visit=${value}; Max-Age=86400; Path=/` })
        .end("<html><head><title>Cookie set</title></head><body><main><p>Cookie set</p></main></body></html>");
    }
    if (key === "ir.issuer.test/show-cookie") {
      return res.writeHead(200, { "content-type": "text/html" }).end(
        `<html><head><title>Cookie</title></head><body><main><p>Cookie: ${req.headers.cookie || "none"}</p></main></body></html>`);
    }
    if (key === "ir.issuer.test/redirect-tls") return res.writeHead(302, { location: "https://10.9.9.9/secret" }).end();
    if (key === "ir.issuer.test/redirect-loopback") return res.writeHead(302, { location: "http://127.0.0.1:8081/landing" }).end();
    if (key === "ir.issuer.test/redirect-out") return res.writeHead(302, { location: "http://evil.test/landing" }).end();
    if (key === "cdn.shared.test/space1/moved.pdf") return res.writeHead(302, { location: "http://10.9.9.9/stolen.pdf" }).end();
    if (key === "ir.issuer.test/files/via-storage") return res.writeHead(302, { location: "http://bucket.storage.test/capital.pdf?Signature=x" }).end();
    if (FILES[key]) {
      const [body, modified, disposition] = FILES[key];
      return res.writeHead(200, { "content-type": "application/pdf", ...(modified ? { "last-modified": modified } : {}),
        ...(disposition ? { "content-disposition": disposition } : {}) }).end(body);
    }
    if (PAGES[key]) return res.writeHead(200, { "content-type": "text/html" }).end(PAGES[key]);
    res.writeHead(404).end("not found");
  });
  // Playwright's request API tunnels through CONNECT even for http: serve the tunnel with the same handler.
  server.on("connect", (req, socket, head) => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) socket.unshift(head);
    server.emit("connection", socket);
  });
  // A WebSocket to ws.thirdparty.test/feed (it arrives in a tunnel, which is served as a connection): one text frame.
  server.on("upgrade", (req, socket) => {
    const key = `${req.headers.host}${new URL(req.url, "http://x").pathname}`;
    hits.push(key);
    if (key !== "ws.thirdparty.test/feed") return void socket.destroy();
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(Buffer.concat([Buffer.from([0x81, 5]), Buffer.from("WS OK")]));
  });
  await new Promise((ok) => server.listen(port, "127.0.0.1", ok));
  return { server, url: `http://127.0.0.1:${server.address().port}`, hits, issuer: ISSUER };
}

// As a script: `node fixture-site.mjs <hits log>` prints the
// proxy URL and appends every requested host/path to the log.
if (import.meta.url === `file://${process.argv[1]}`) {
  const site = await startFixtureSite();
  const log = process.argv[2];
  if (log) site.server.on("request", (req) => appendFileSync(log, `${new URL(req.url, `http://${req.headers.host}`).host}${new URL(req.url, `http://${req.headers.host}`).pathname}\n`));
  process.stdout.write(`${site.url}\n`);
}
