// The policy proxy: new. One per browser, on 127.0.0.1; Chrome sends every connection through it. It exists because
// patchright's `context.route` never sees a redirect hop or a WebSocket, while the proxy sees every connection.
// It resolves each name once, refuses a local or private address, and connects to the address it checked, so a
// name whose DNS answer changes between check and connection (DNS rebinding) cannot slip through. Patchright adds
// `<-loopback>` to Chrome's proxy bypass list, so loopback goes through the proxy too. The rules are policy.mjs's.
// In tests `upstream` is the fixture proxy (the internet's stand-in); the address is not pinned there.

import http from "node:http";
import net from "node:net";
import { isPrivateHost, refuse, reject, resolveHost } from "./policy.mjs";

const DROPPED = new Set(["proxy-connection", "proxy-authorization"]);

/** `host:port` or `[v6]:port` -> {host, port}. */
function splitAuthority(authority) {
  const m = authority.match(/^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/);
  return m ? { host: m[1] ?? m[2], port: Number(m[3]) } : null;
}

export async function startProxy({ lookup, upstream, onRefused }) {
  const up = upstream ? new URL(upstream) : null;
  const sockets = new Set();
  const track = (socket) => {
    // A kept-alive socket to an origin or upstream comes back for every request: listen on it once.
    if (sockets.has(socket)) return socket;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    return socket;
  };
  const server = http.createServer();
  server.on("connection", track);

  const forbid = (socket, authority, { reason, address }) => {
    onRefused({ url: authority, reason, address });
    socket.end(`HTTP/1.1 403 Forbidden\r\nx-source-policy: ${reason}\r\nconnection: close\r\n\r\n`);
  };

  server.on("request", async (req, res) => {
    try {
      // One lookup per request: the address checked is the address connected to.
      const reason = reject(req.url);
      const target = reason ? { reason } : await resolveHost(new URL(req.url).hostname, lookup);
      if (target.reason) {
        onRefused({ url: req.url, reason: target.reason, address: target.address });
        const body = `${req.url} is blocked (${target.reason})`;
        res.writeHead(403, { "content-type": "text/plain", "x-source-policy": target.reason, "content-length": Buffer.byteLength(body) });
        return void res.end(body);
      }
      const url = new URL(req.url);
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !DROPPED.has(k)));
      const options = up
        ? { host: up.hostname, port: up.port, path: req.url, headers, method: req.method }
        : { host: target.address, port: url.port || 80, path: url.pathname + url.search, headers, method: req.method, setHost: false };
      const out = http.request(options, (back) => {
        // A cut-off response must not take the daemon down with an unhandled error.
        back.on("error", () => res.destroy());
        // Only the proxy says a request was refused: a site's own x-source-policy header is dropped.
        const raw = [];
        for (let i = 0; i < back.rawHeaders.length; i += 2) {
          if (back.rawHeaders[i].toLowerCase() !== "x-source-policy") raw.push(back.rawHeaders[i], back.rawHeaders[i + 1]);
        }
        res.writeHead(back.statusCode, raw);
        back.pipe(res);
      });
      out.on("socket", track); // so close() ends a request still connecting or streaming
      req.on("error", () => out.destroy());
      out.on("error", () => {
        if (res.headersSent) res.destroy();
        else res.writeHead(502).end();
      });
      req.pipe(out);
    } catch {
      if (res.headersSent) res.destroy();
      else res.writeHead(502).end();
    }
  });

  // https and every WebSocket arrive as CONNECT host:port.
  server.on("connect", async (req, socket, head) => {
    try {
      const target = splitAuthority(req.url);
      if (!target) return void socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      const refusal = isPrivateHost(target.host) ? { reason: "private_host" } : await resolveHost(target.host, lookup);
      if (refusal.reason) return forbid(socket, req.url, refusal);
      const peer = track(net.connect(up ? { host: up.hostname, port: Number(up.port) } : { host: refusal.address, port: target.port }));
      socket.on("close", () => peer.destroy());
      peer.on("close", () => socket.destroy());
      const tunnel = () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) peer.write(head);
        socket.pipe(peer);
        peer.pipe(socket);
      };
      if (!up) return void peer.once("connect", tunnel);
      peer.once("connect", () => {
        peer.write(`CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\n\r\n`);
        let buffered = Buffer.alloc(0);
        const onData = (chunk) => {
          buffered = Buffer.concat([buffered, chunk]);
          const end = buffered.indexOf("\r\n\r\n");
          if (end < 0) return;
          peer.off("data", onData);
          if (!/^HTTP\/1\.[01] 200/.test(buffered.toString("latin1", 0, end))) return void socket.destroy();
          const rest = buffered.subarray(end + 4);
          tunnel();
          if (rest.length) socket.write(rest);
        };
        peer.on("data", onData);
      });
    } catch {
      socket.destroy();
    }
  });

  // Chrome sends WebSockets through CONNECT; an absolute-URI Upgrade request is checked, then refused: fail closed.
  server.on("upgrade", async (req, socket) => {
    const refusal = await refuse(req.url, lookup).catch(() => ({ reason: "invalid_url" }));
    if (refusal) onRefused({ url: req.url, ...refusal });
    socket.destroy();
  });

  await new Promise((ok, err) => {
    server.once("error", err);
    server.listen(0, "127.0.0.1", ok);
  });
  return {
    port: server.address().port,
    close: () => new Promise((ok) => {
      server.close(ok);
      for (const socket of sockets) socket.destroy();
    }),
  };
}
