/**
 * URL identity helpers.
 *
 * Two very different jobs live here, and they must not be confused:
 *
 *   canonicalizeUrl()   normalisation that is *safe* to treat as identity:
 *                       it only removes things that can never select a different
 *                       resource (fragment, known tracking parameters, query order).
 *   siteRuleAlias()     a deliberately looser key used by the citation matcher as a
 *                       *secondary* tier. It folds host aliases that usually mean the
 *                       same article (www / m. / amp / trailing slash). It is never
 *                       used as the primary identity, and every match made through it
 *                       is recorded with its own match method.
 */

// Campaign/click identifiers. Kept as an explicit list so an unknown parameter is
// preserved rather than silently dropped: a query string can select a different
// document, and losing one would merge two distinct sources.
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "igshid",
  "yclid",
  "twclid",
  "vero_id",
  "vero_conv",
  "mc_cid",
  "mc_eid",
  "_ga",
  "_gl",
  "ref_src",
  "spm",
  "spm_id_from",
  "vd_source",
  "share_source",
  "share_medium",
  "from_source",
  "src",
]);

// Hosts that belong to the provider itself. Matched on DNS label boundaries so
// "notdoubao.com" is not mistaken for a Doubao host.
const INTERNAL_SOURCE_HOSTS = [
  "doubao.com",
  "bytedance.com",
  "byteimg.com",
  "zijieapi.com",
  "feiliao.com",
  "snssdk.com",
];

// Sub-domains that identify a *presentation* of the same page rather than a
// different site.
const SITE_ALIAS_SUBDOMAINS = new Set([
  "www",
  "m",
  "mobile",
  "amp",
  "touch",
  "so",
  "mip",
]);

function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function isInternalHost(host) {
  return INTERNAL_SOURCE_HOSTS.some((domain) => hostMatches(host, domain));
}

function isTrackingParam(key) {
  const lower = key.toLowerCase();
  return lower.startsWith("utm_") || TRACKING_PARAMS.has(lower);
}

function parsedHttpUrl(raw) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol)) return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * Query parameters are re-appended in sorted order. `?a=1&b=2` and `?b=2&a=1`
 * address the same resource, so leaving them in arrival order created false
 * "different URL" verdicts during matching.
 */
function sortSearchParams(url) {
  const entries = [...url.searchParams.entries()];
  if (entries.length < 2) return;
  entries.sort(([aKey, aValue], [bKey, bValue]) =>
    aKey === bKey ? aValue.localeCompare(bValue) : aKey.localeCompare(bKey),
  );
  url.search = "";
  for (const [key, value] of entries) url.searchParams.append(key, value);
}

export function canonicalizeUrl(raw) {
  const url = parsedHttpUrl(raw);
  if (!url) return null;
  url.hash = "";

  for (const key of [...url.searchParams.keys()]) {
    if (isTrackingParam(key)) url.searchParams.delete(key);
  }
  sortSearchParams(url);

  return url.toString();
}

export function domainFromUrl(raw) {
  const url = parsedHttpUrl(raw);
  return url ? url.hostname.toLowerCase() : null;
}

export function isExternalSourceUrl(raw) {
  const host = domainFromUrl(raw);
  if (!host) return false;
  return !isInternalHost(host);
}

/**
 * Secondary matching key for the retrieval -> citation matcher.
 *
 * Folds presentation-level host aliases and the empty trailing slash. It is
 * intentionally *not* part of canonicalizeUrl: two URLs that differ only by
 * "www." are not proven to be the same article, so a match made this way is
 * labelled "site_rule_alias" instead of "canonical_url_exact".
 */
export function siteRuleAlias(raw) {
  const canonical = canonicalizeUrl(raw);
  if (!canonical) return null;
  try {
    const url = new URL(canonical);
    const labels = url.hostname.toLowerCase().split(".");
    if (labels.length > 2 && SITE_ALIAS_SUBDOMAINS.has(labels[0])) {
      labels.shift();
      url.hostname = labels.join(".");
    }
    if (url.pathname === "/") url.pathname = "";
    return url.toString();
  } catch {
    return canonical;
  }
}