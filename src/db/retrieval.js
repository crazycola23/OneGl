import { canonicalizeUrl, domainFromUrl } from "../url.js";
import { normalizeDomain } from "./domain.js";

function compactText(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

export function prepareSearchQueries(queries) {
  const rows = [];
  const seen = new Set();
  for (const value of Array.isArray(queries) ? queries : []) {
    const query = compactText(value, 1_000);
    if (!query) continue;
    const key = query.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ queryPosition: rows.length + 1, queryText: query });
  }
  return rows;
}

export function prepareRetrievedSources(sources) {
  const rows = [];
  const skipped = [];
  const seen = new Set();

  for (const [index, source] of (Array.isArray(sources) ? sources : []).entries()) {
    if (source?.sourceType && source.sourceType !== "retrieved") {
      skipped.push({ index, reason: "not-retrieved" });
      continue;
    }
    if (source?.visibleToUser === true) {
      skipped.push({ index, reason: "visible-source-in-retrieved-set" });
      continue;
    }

    const originalUrl = source?.url ?? null;
    const canonicalUrl = source?.canonicalUrl ?? canonicalizeUrl(originalUrl);
    if (!originalUrl || !canonicalUrl) {
      skipped.push({ index, reason: "missing-url" });
      continue;
    }
    if (seen.has(canonicalUrl)) continue;
    seen.add(canonicalUrl);

    const domain = source?.domain ?? domainFromUrl(canonicalUrl);
    const requested = Number(source?.sourcePosition);
    rows.push({
      canonicalUrl,
      originalUrl,
      title: compactText(source?.title, 500),
      domain: domain ?? "unknown",
      normalizedDomain: normalizeDomain(domain) ?? "unknown",
      sourcePosition:
        Number.isInteger(requested) && requested > 0 ? requested : rows.length + 1,
      sourceName: compactText(source?.sourceName, 300),
      summary: compactText(source?.summary, 4_000),
      capturedFrom: "NETWORK",
      visibleToUser: false,
    });
  }

  return { rows, skipped };
}

export const MATCH_METHODS = Object.freeze({
  EXACT: "canonical_url_exact",
  REDIRECT: "canonical_url_redirect",
  HTML_CANONICAL: "canonical_url_html",
  SITE_RULE: "site_rule_alias",
  CONTENT_HASH: "content_hash_alias",
});

function lookup(index, key) {
  if (!key) return null;
  return index?.get?.(key) ?? null;
}

function indexOf(entries) {
  if (entries instanceof Map) return entries;
  const index = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const key = entry?.canonicalUrl ?? entry?.canonical_url ?? null;
    if (key && !index.has(key)) index.set(key, entry);
  }
  return index;
}

/**
 * Retrieval -> visible-citation match, in strict confidence order.
 *
 * Every tier below `canonical_url_exact` is a *separate, labelled* method, never a
 * silent widening of the exact metric. The exact tier stays authoritative; the alias
 * tiers exist because the same article is routinely observed under a different URL
 * shape on the network side (redirect target, HTML <link rel=canonical>, mobile/AMP
 * host) than in the rendered citation list, and counting those as "not cited"
 * systematically understates the overlap the report is trying to measure.
 *
 * `aliases` may be given in two shapes:
 *   - a Map of alias key -> citation, or
 *   - `{ redirect, htmlCanonical, siteRule, contentHash }`, each a Map or an array of
 *     citations that will be indexed by their own canonicalUrl.
 */
export function exactCitationMatch(retrievedCanonicalUrl, visibleByCanonicalUrl, aliases = null) {
  const exactIndex = indexOf(visibleByCanonicalUrl);
  const exact = exactIndex.get(retrievedCanonicalUrl) ?? null;
  if (exact) {
    return { visibleCitationId: exact.id, matchMethod: MATCH_METHODS.EXACT };
  }

  const tiers = [
    [MATCH_METHODS.REDIRECT, aliases?.redirect],
    [MATCH_METHODS.HTML_CANONICAL, aliases?.htmlCanonical],
    [MATCH_METHODS.SITE_RULE, aliases?.siteRule],
    [MATCH_METHODS.CONTENT_HASH, aliases?.contentHash],
  ];
  for (const [matchMethod, bucket] of tiers) {
    const citation = lookup(indexOf(bucket), retrievedCanonicalUrl);
    if (citation) return { visibleCitationId: citation.id, matchMethod };
  }

  return { visibleCitationId: null, matchMethod: null };
}
