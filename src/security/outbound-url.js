import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const blocked = new net.BlockList();

for (const [address, prefix] of [
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
]) blocked.addSubnet(address, prefix, "ipv4");

for (const [address, prefix] of [
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
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
]) blocked.addSubnet(address, prefix, "ipv6");

function familyName(family) {
  return Number(family) === 6 ? "ipv6" : "ipv4";
}

export function isPublicIpAddress(address, family = net.isIP(address)) {
  const detected = Number(family) || net.isIP(address);
  if (detected !== 4 && detected !== 6) return false;
  return !blocked.check(String(address), familyName(detected));
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
  const literalFamily = net.isIP(parsed.hostname);
  const addresses = literalFamily
    ? [{ address: parsed.hostname, family: literalFamily }]
    : await lookup(parsed.hostname, { all: true, verbatim: true });

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
  return new Promise((resolve, reject) => {
    const request = requestImpl.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method,
      headers,
      servername: net.isIP(url.hostname) ? undefined : url.hostname,
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
