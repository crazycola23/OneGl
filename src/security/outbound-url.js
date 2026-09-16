import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const BLOCKED_IPV4 = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const BLOCKED_IPV6 = [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
];

function stripIpv6Brackets(value) {
  const text = String(value);
  return text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
}

function ipv4ToBigInt(address) {
  const parts = String(address).split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const raw of parts) {
    if (!/^\d{1,3}$/.test(raw)) return null;
    const octet = Number(raw);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function ipv6ToBigInt(rawAddress) {
  let address = stripIpv6Brackets(rawAddress).toLowerCase();
  if (!address || address.includes("%")) return null;

  if (address.includes(".")) {
    const separator = address.lastIndexOf(":");
    if (separator < 0) return null;
    const ipv4 = ipv4ToBigInt(address.slice(separator + 1));
    if (ipv4 == null) return null;
    const upper = Number((ipv4 >> 16n) & 0xffffn).toString(16);
    const lower = Number(ipv4 & 0xffffn).toString(16);
    address = `${address.slice(0, separator)}:${upper}:${lower}`;
  }

  const compressed = address.split("::");
  if (compressed.length > 2) return null;
  const left = compressed[0] ? compressed[0].split(":") : [];
  const right = compressed.length === 2 && compressed[1] ? compressed[1].split(":") : [];
  const validate = (word) => /^[0-9a-f]{1,4}$/.test(word);
  if (!left.every(validate) || !right.every(validate)) return null;

  let words;
  if (compressed.length === 1) {
    if (left.length !== 8) return null;
    words = left;
  } else {
    const zeros = 8 - left.length - right.length;
    if (zeros < 1) return null;
    words = [...left, ...Array(zeros).fill("0"), ...right];
  }
  if (words.length !== 8) return null;

  let value = 0n;
  for (const word of words) value = (value << 16n) | BigInt(Number.parseInt(word, 16));
  return value;
}

function inCidr(value, base, bits, prefix) {
  const shift = BigInt(bits - prefix);
  return (value >> shift) === (base >> shift);
}

const BLOCKED_IPV4_PARSED = BLOCKED_IPV4.map(([base, prefix]) => [ipv4ToBigInt(base), prefix]);
const BLOCKED_IPV6_PARSED = BLOCKED_IPV6.map(([base, prefix]) => [ipv6ToBigInt(base), prefix]);

export function isPublicIpAddress(address, family = net.isIP(stripIpv6Brackets(address))) {
  const normalized = stripIpv6Brackets(address);
  const detected = Number(family) || net.isIP(normalized);
  if (detected === 4) {
    const value = ipv4ToBigInt(normalized);
    if (value == null) return false;
    return !BLOCKED_IPV4_PARSED.some(([base, prefix]) => inCidr(value, base, 32, prefix));
  }
  if (detected === 6) {
    const value = ipv6ToBigInt(normalized);
    if (value == null) return false;
    return !BLOCKED_IPV6_PARSED.some(([base, prefix]) => inCidr(value, base, 128, prefix));
  }
  return false;
}

export function parseOutboundUrl(raw, { allowHttp = false } = {}) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error("outbound URL is invalid");
  }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new Error(allowHttp ? "outbound URL must use HTTP or HTTPS" : "outbound URL must use HTTPS");
  }
  if (!url.hostname) throw new Error("outbound URL must include a hostname");
  if (url.username || url.password) throw new Error("outbound URL must not contain credentials");
  if (url.hash) url.hash = "";
  return url;
}

export async function resolvePublicTarget(url, { lookup = dns.lookup } = {}) {
  const parsed = url instanceof URL ? url : parseOutboundUrl(url, { allowHttp: true });
  const hostname = stripIpv6Brackets(parsed.hostname);
  const literalFamily = net.isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookup(hostname, { all: true, verbatim: true });

  if (!Array.isArray(addresses) || !addresses.length) {
    throw new Error("outbound hostname did not resolve");
  }
  for (const item of addresses) {
    if (!isPublicIpAddress(item.address, item.family)) {
      throw new Error(`outbound hostname resolves to a non-public address (${item.address})`);
    }
  }
  return addresses.map((item) => ({ address: String(item.address), family: Number(item.family) }));
}

export async function validatePublicOutboundUrl(raw, { allowHttp = false, lookup = dns.lookup } = {}) {
  const url = parseOutboundUrl(raw, { allowHttp });
  await resolvePublicTarget(url, { lookup });
  return url.toString();
}

function requestWithPinnedLookup(url, addresses, { method, headers, body, timeoutMs, maxResponseBytes }) {
  const target = addresses[0];
  const requestImpl = url.protocol === "https:" ? https : http;
  const hostname = stripIpv6Brackets(url.hostname);
  return new Promise((resolve, reject) => {
    const request = requestImpl.request({
      protocol: url.protocol,
      hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method,
      headers,
      servername: net.isIP(hostname) ? undefined : hostname,
      lookup: (_hostname, options, callback) => {
        if (options?.all) return callback(null, [target]);
        return callback(null, target.address, target.family);
      },
    }, (response) => {
      let captured = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        if (captured.length < maxResponseBytes) {
          captured += String(chunk).slice(0, maxResponseBytes - captured.length);
        }
      });
      response.on("end", () => resolve({
        status: Number(response.statusCode ?? 0),
        ok: Number(response.statusCode ?? 0) >= 200 && Number(response.statusCode ?? 0) < 300,
        body: captured,
        headers: response.headers,
        connectedAddress: target.address,
      }));
    });
    request.on("error", reject);
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`outbound request timed out after ${timeoutMs}ms`)));
    if (body != null) request.write(body);
    request.end();
  });
}

/**
 * Resolve, reject every private/reserved answer, then pin the actual socket lookup to a
 * prevalidated public address. Node's http/https client does not follow redirects by default,
 * so a 3xx response cannot redirect delivery into an internal network.
 */
export async function safeOutboundRequest(rawUrl, {
  method = "POST",
  headers = {},
  body = null,
  timeoutMs = 10_000,
  maxResponseBytes = 2_000,
  allowHttp = false,
  lookup = dns.lookup,
} = {}) {
  const url = parseOutboundUrl(rawUrl, { allowHttp });
  const addresses = await resolvePublicTarget(url, { lookup });
  return requestWithPinnedLookup(url, addresses, {
    method,
    headers,
    body,
    timeoutMs,
    maxResponseBytes,
  });
}
