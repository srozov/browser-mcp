import assert from "node:assert/strict";
import { test } from "node:test";
import { allowRequest, isDocumentType, isPrivateAddress, isPrivateHost, normalize, refuse, reject, resolveHost, testLookup } from "../src/policy.mjs";

test("any public http(s) URL passes, whoever hosts it", () => {
  for (const url of ["https://www.issuer.example/investors", "https://filings.regulator.example/archive/x.htm",
    "https://cdn.shared.example/f/113/ar.pdf", "http://www.exchange.example/listed/x.pdf"]) {
    assert.equal(reject(url), null, url);
  }
});

test("local, private and non-http targets are rejected", () => {
  for (const url of ["http://localhost:8080/", "http://127.0.0.1:7331/runs", "http://10.1.2.3/", "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data", "http://[::1]/", "http://[fd00::1]/", "http://intranet/",
    "http://printer.local/", "http://100.70.1.1:8080/mcp", "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/",
    "http://2130706433/"]) {
    assert.equal(reject(url), "private_host", url);
  }
  for (const url of ["file:///etc/passwd", "ftp://issuer.example/x", "javascript:alert(1)", "chrome://settings"]) {
    assert.equal(reject(url), "scheme", url);
  }
  assert.equal(reject("https://user:pw@www.issuer.example/"), "credentials_in_url");
  assert.equal(reject("not a url"), "invalid_url");
});

test("private host detection", () => {
  assert.ok(isPrivateHost("LOCALHOST"));
  assert.ok(isPrivateHost("a.localhost"));
  assert.ok(isPrivateHost("172.20.0.1"));
  assert.ok(isPrivateHost("::ffff:127.0.0.1"));
  assert.ok(!isPrivateHost("172.32.0.1"));
  assert.ok(!isPrivateHost("8.8.8.8"));
  assert.ok(!isPrivateHost("cdn.shared.example"));
});

test("address ranges: mapped IPv4, link-local, multicast, documentation ranges", () => {
  assert.ok(isPrivateAddress("::ffff:10.0.0.1"));
  assert.ok(isPrivateAddress("::ffff:7f00:1"));
  assert.ok(!isPrivateAddress("::ffff:203.0.113.10"));
  assert.ok(isPrivateAddress("fe80::1"));
  assert.ok(isPrivateAddress("fe80::1%eth0"));
  assert.ok(isPrivateAddress("fc00::1"));
  assert.ok(isPrivateAddress("::"));
  assert.ok(isPrivateAddress("224.0.0.1"));
  assert.ok(isPrivateAddress("255.255.255.255"));
  assert.ok(!isPrivateAddress("203.0.113.10"));
  assert.ok(!isPrivateAddress("2001:db8::1"));
});

test("browser requests: inline data and public hosts load, private hosts never", () => {
  assert.deepEqual(allowRequest("data:image/png;base64,AAAA"), { ok: true, reason: "inline" });
  assert.deepEqual(allowRequest("https://widget.thirdparty.example/quote"), { ok: true, reason: "public" });
  assert.deepEqual(allowRequest("http://127.0.0.1:7331/runs"), { ok: false, reason: "private_host" });
});

test("normalize drops the fragment; document types", () => {
  assert.equal(normalize("https://x.example/a.pdf#page=3"), "https://x.example/a.pdf");
  assert.equal(normalize("::"), null);
  assert.ok(isDocumentType("application/pdf; charset=binary"));
  assert.ok(isDocumentType("text/csv"));
  assert.ok(!isDocumentType("text/html"));
});

const answer = (...addresses) => async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
const never = async () => { throw new Error("looked up"); };

test("refuse checks the addresses a name resolves to", async () => {
  assert.equal(await refuse("http://a.example/", answer("203.0.113.10")), null);
  assert.deepEqual(await refuse("http://a.example/", answer("127.0.0.1")), { reason: "resolves_private", address: "127.0.0.1" });
  assert.deepEqual(await refuse("http://a.example/", answer("10.9.9.9")), { reason: "resolves_private", address: "10.9.9.9" });
  assert.deepEqual(await refuse("http://a.example/", answer("fe80::1%eth0")), { reason: "resolves_private", address: "fe80::1%eth0" });
  assert.deepEqual(await refuse("http://a.example/", answer("203.0.113.10", "10.0.0.1")), { reason: "resolves_private", address: "10.0.0.1" });
  assert.deepEqual(await refuse("http://a.example/", never), { reason: "unresolved" });
  assert.deepEqual(await refuse("http://a.example/", answer()), { reason: "unresolved" });
});

test("refuse never looks up an IP literal, and lets inline data through", async () => {
  assert.deepEqual(await refuse("http://127.0.0.1/", never), { reason: "private_host" });
  assert.equal(await refuse("http://203.0.113.10/", never), null);
  assert.equal(await refuse("http://[2001:db8::1]/", never), null);
  assert.equal(await refuse("data:text/plain,x", never), null);
  assert.deepEqual(await refuse("file:///etc/passwd", never), { reason: "scheme" });
  assert.deepEqual(await resolveHost("[2001:db8::1]", never), { address: "2001:db8::1" });
});

test("testLookup resolves a map case-insensitively and rejects bad maps", async () => {
  const lookup = testLookup('{"a.test": ["203.0.113.10", "2001:db8::1"]}');
  assert.deepEqual(await lookup("A.test"), [{ address: "203.0.113.10", family: 4 }, { address: "2001:db8::1", family: 6 }]);
  await assert.rejects(lookup("b.test"), /does not resolve/);
  for (const bad of ["nope", "[]", '{"a.test": []}', '{"a.test": ["not-an-ip"]}', '{"a.test": "1.2.3.4"}', "null"]) {
    assert.throws(() => testLookup(bad), /BROWSER_TEST_HOSTS must be JSON/, bad);
  }
});
