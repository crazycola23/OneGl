const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "msclkid",
  "igshid",
  "yclid",
]);

const INTERNAL_SOURCE_HOST_PARTS = [
  "doubao.com",
  "bytedance",
  "zijieapi",
  "byteimg",
  "feiliao",
];

export function canonicalizeUrl(raw) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.hash = "";

    for (const key of [...url.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (lower.startsWith("utm_") || TRACKING_PARAMS.has(lower)) {
        url.searchParams.delete(key);
      }
    }

    return url.toString();
  } catch {
    return null;
  }
}

export function domainFromUrl(raw) {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isExternalSourceUrl(raw) {
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol)) return false;
    const host = url.hostname.toLowerCase();
    return !INTERNAL_SOURCE_HOST_PARTS.some((part) => host.includes(part));
  } catch {
    return false;
  }
}
