// The source policy: the rules for every URL a browser may open or a page may load. Any public http(s) site
// passes; no local or private host (by name, and by the addresses its name resolves to), no non-http(s)
// scheme, no credentials in a URL. Pure rules plus an injected resolver, so every rule is unit-tested without
// the network. The name rules, `normalize`, `isDocumentType`, `reject` and `allowRequest` are moved from the
// page readers' policy module; the address ranges as a BlockList, `resolveHost`, `refuse` and `testLookup` are new.

import { promises as dns } from "node:dns";
import { BlockList, isIP } from "node:net";

const DOCUMENT_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/csv",
];

// The ranges no browser may reach. Documentation ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24) stay public.
const PRIVATE = new BlockList();
for (const [net, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["127.0.0.0", 8], ["100.64.0.0", 10], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.168.0.0", 16], ["224.0.0.0", 3]]) PRIVATE.addSubnet(net, prefix, "ipv4");
PRIVATE.addAddress("::", "ipv6");
PRIVATE.addAddress("::1", "ipv6");
PRIVATE.addSubnet("fc00::", 7, "ipv6");
PRIVATE.addSubnet("fe80::", 10, "ipv6");

export function parse(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** The URL without its fragment. */
export function normalize(url) {
  const u = parse(url);
  if (!u) return null;
  u.hash = "";
  return u.href;
}

/** Whether an IP address is in a private range. An IPv4-mapped IPv6 address is checked as the IPv4 address it carries. */
export function isPrivateAddress(ip) {
  const host = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const family = isIP(host);
  if (family === 4) return PRIVATE.check(host, "ipv4");
  if (family !== 6) return false;
  // The URL parser writes every IPv4-mapped address as ::ffff:<hex>:<hex>, whatever form it was given in.
  const mapped = new URL(`http://[${host}]/`).hostname.match(/^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/);
  if (mapped) {
    const [hi, lo] = [Number.parseInt(mapped[1], 16), Number.parseInt(mapped[2], 16)];
    return PRIVATE.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, "ipv4");
  }
  return PRIVATE.check(host, "ipv6");
}

/** Hostnames that must never be reached: loopback, private and link-local ranges, local names. */
export function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host.endsWith(".internal") || host.endsWith(".lan") || !host.includes(".") && !isIP(host)) return true;
  return isIP(host) ? isPrivateAddress(host) : false;
}

export function isDocumentType(contentType) {
  const type = (contentType || "").split(";")[0].trim().toLowerCase();
  return DOCUMENT_TYPES.includes(type);
}

/** The gate for any URL: http(s), no credentials, public host. Returns a rejection reason or null. */
export function reject(url) {
  const u = parse(url);
  if (!u) return "invalid_url";
  if (u.protocol !== "https:" && u.protocol !== "http:") return "scheme";
  if (u.username || u.password) return "credentials_in_url";
  if (isPrivateHost(u.hostname)) return "private_host";
  return null;
}

/** A request made by the browser itself: inline data, or any URL that passes reject(). Name check only. */
export function allowRequest(url) {
  const u = parse(url);
  if (u && (u.protocol === "data:" || u.protocol === "blob:")) return { ok: true, reason: "inline" };
  const reason = reject(url);
  return reason ? { ok: false, reason } : { ok: true, reason: "public" };
}

export const systemLookup = (host) => dns.lookup(host, { all: true });

/**
 * The address to connect to for a host whose name passed isPrivateHost: `{ address }`, or `{ reason, address? }`.
 * An IP literal is never looked up. One private address among public ones refuses the name.
 */
export async function resolveHost(hostname, lookup) {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return { address: host };
  let answers;
  try {
    answers = await lookup(host);
  } catch {
    return { reason: "unresolved" };
  }
  if (!answers?.length) return { reason: "unresolved" };
  const private_ = answers.find((a) => isPrivateAddress(a.address));
  if (private_) return { reason: "resolves_private", address: private_.address };
  return { address: answers[0].address };
}

/** The full check of a URL: the name rules, then the resolved addresses. Returns null or `{ reason, address? }`. */
export async function refuse(url, lookup) {
  const u = parse(url);
  if (u && (u.protocol === "data:" || u.protocol === "blob:")) return null;
  const reason = reject(url);
  if (reason) return { reason };
  const { reason: why, address } = await resolveHost(u.hostname, lookup);
  return why ? { reason: why, ...(address ? { address } : {}) } : null;
}

/** BROWSER_TEST_HOSTS, a JSON map {name: [IP addresses]}, as a resolver. Throws on anything else. */
export function testLookup(json) {
  const wrong = (what) => new Error(`BROWSER_TEST_HOSTS must be JSON {name: [IP addresses]}: ${what}`);
  let map;
  try {
    map = JSON.parse(json);
  } catch {
    throw wrong("it is not JSON");
  }
  if (!map || typeof map !== "object" || Array.isArray(map)) throw wrong("it is not an object");
  for (const [name, list] of Object.entries(map)) {
    if (!name) throw wrong("a name is empty");
    if (!Array.isArray(list) || !list.length) throw wrong(`${name} needs a non-empty list`);
    for (const a of list) if (typeof a !== "string" || !isIP(a)) throw wrong(`${name} has ${JSON.stringify(a)}, not an IP address`);
  }
  return async (host) => {
    const list = map[host.toLowerCase()];
    if (!list) throw new Error(`${host} does not resolve`);
    return list.map((address) => ({ address, family: isIP(address) }));
  };
}
