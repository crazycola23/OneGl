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

export function exactCitationMatch(retrievedCanonicalUrl, visibleByCanonicalUrl) {
  const citation = visibleByCanonicalUrl.get(retrievedCanonicalUrl) ?? null;
  if (!citation) return { visibleCitationId: null, matchMethod: null };
  return {
    visibleCitationId: citation.id,
    matchMethod: "canonical_url_exact",
  };
}
