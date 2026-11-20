import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { test } from "node:test";
import { startProxy } from "../src/proxy.mjs";

const listen = async (server) => {
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return server.address().port;
};

/** A plain-http request through the proxy; resolves with the response, or with the error. */
const via = (proxyPort, url) => {
  const req = request({ host: "127.0.0.1", port: proxyPort, path: url, headers: { host: new URL(url).host } });
  const done = new Promise((ok) => {
    req.on("response", (res) => {
      res.on("error", ok);
      res.resume();
      res.on("end", () => ok(res));
    });
    req.on("error", ok);
  });
  req.end();
  return { req, done };
};

test("the proxy looks a name up once and connects to the address it checked", async () => {
  const hits = [];
  const local = createServer((req, res) => { hits.push(req.url); res.end("local"); });
  const port = await listen(local);
  let calls = 0;
  // Public on the first answer, loopback on any later one: a second lookup would reach the local server.
  const lookup = async () => [{ address: calls++ ? "127.0.0.1" : "203.0.113.10", family: 4 }];
  const proxy = await startProxy({ lookup, onRefused: () => {} });
  const { req } = via(proxy.port, `http://rebind.example:${port}/x`);
  await new Promise((ok) => setTimeout(ok, 300));
  assert.equal(calls, 1);
  assert.deepEqual(hits, []);
  req.destroy();
  await proxy.close();
  local.close();
});

test("a response cut off mid-body ends that request, not the process", async () => {
  const upstream = createServer((req, res) => {
    res.writeHead(200, { "content-length": "100" });
    res.write("partial");
    setTimeout(() => res.socket.destroy(), 50);
  });
  const lookup = async () => [{ address: "203.0.113.10", family: 4 }];
  const proxy = await startProxy({ lookup, upstream: `http://127.0.0.1:${await listen(upstream)}`, onRefused: () => {} });
  await via(proxy.port, "http://cut.example/x").done;
  await new Promise((ok) => setTimeout(ok, 100));
  await proxy.close();
  upstream.close();
});

test("a site's own x-source-policy header is not passed on", async () => {
  const upstream = createServer((req, res) => res.writeHead(200, { "x-source-policy": "private_host" }).end("ok"));
  const lookup = async () => [{ address: "203.0.113.10", family: 4 }];
  const proxy = await startProxy({ lookup, upstream: `http://127.0.0.1:${await listen(upstream)}`, onRefused: () => {} });
  const res = await via(proxy.port, "http://site.example/x").done;
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["x-source-policy"], undefined);
  await proxy.close();
  upstream.close();
});
