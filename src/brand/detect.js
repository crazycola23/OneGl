/**
 * Rule-based brand mention detection.
 *
 * This is deliberately the first stage: aliases and exclude patterns are explicit and
 * auditable, and the raw answer is always kept so a human can check any verdict. An
 * LLM judge can be layered on later without changing the stored shape.
 *
 * `position` values are 0-based UTF-16 offsets into the original answer string.
 */

export const BRAND_DETECTION_VERSION = "rules-v1";

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toTermList(values) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

export function compileBrandRules(brand = {}) {
  const name = String(brand.name ?? "").trim();
  const aliasTerms = toTermList([...(brand.aliases ?? []), name]);
  const productTerms = toTermList(brand.productAliases ?? []).filter(
    (term) => !aliasTerms.includes(term),
  );

  const terms = [
    ...aliasTerms.map((term) => ({ term, kind: "brand" })),
    ...productTerms.map((term) => ({ term, kind: "product" })),
  ].map((entry) => ({
    ...entry,
    regex: new RegExp(escapeRegExp(entry.term), "gi"),
  }));

  // Exclude patterns are regular expressions supplied by the operator, used to blank
  // out contexts where an alias means something else (for example a phone brand).
  const excludes = toTermList(brand.excludePatterns ?? []).map((source) => {
    try {
      return { source, regex: new RegExp(source, "gi") };
    } catch (error) {
      throw new Error(`Invalid brand exclude pattern ${JSON.stringify(source)}: ${error.message}`);
    }
  });

  return { name, terms, excludes };
}

function collectSpans(text, regexes) {
  const spans = [];
  for (const { regex } of regexes) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
      if (match[0].length === 0) {
        regex.lastIndex += 1;
        continue;
      }
      spans.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return spans;
}

// Replace excluded spans with spaces of equal length so offsets in the masked text
// still line up with the original answer.
function maskSpans(text, spans) {
  if (!spans.length) return text;
  const ordered = [...spans].sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const span of ordered) {
    if (span.start < cursor) continue;
    out += text.slice(cursor, span.start) + " ".repeat(span.end - span.start);
    cursor = span.end;
  }
  return out + text.slice(cursor);
}

// Overlapping matches would double count: "小米SU7" must not count once as "小米SU7"
// and again as "SU7". Prefer the longest match at each position.
function resolveOverlaps(matches) {
  const ordered = [...matches].sort(
    (a, b) => a.position - b.position || b.length - a.length || a.term.localeCompare(b.term),
  );
  const kept = [];
  let lastEnd = -1;
  for (const match of ordered) {
    if (match.position < lastEnd) continue;
    kept.push(match);
    lastEnd = match.position + match.length;
  }
  return kept;
}

export function detectBrandMention(answer, rules) {
  const text = typeof answer === "string" ? answer : "";
  if (!text || !rules.terms.length) {
    return {
      version: BRAND_DETECTION_VERSION,
      mentioned: false,
      mentionCount: 0,
      firstMentionPosition: null,
      matchedTerms: [],
      excludedMatchCount: 0,
    };
  }

  const excludedSpans = collectSpans(text, rules.excludes);
  const masked = maskSpans(text, excludedSpans);

  const rawMatches = [];
  for (const { term, kind, regex } of rules.terms) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(masked)) !== null) {
      if (match[0].length === 0) {
        regex.lastIndex += 1;
        continue;
      }
      rawMatches.push({
        term,
        kind,
        position: match.index,
        length: match[0].length,
      });
    }
  }

  const matches = resolveOverlaps(rawMatches);

  const byTerm = new Map();
  for (const match of matches) {
    const entry = byTerm.get(match.term) ?? {
      term: match.term,
      kind: match.kind,
      count: 0,
      firstPosition: match.position,
    };
    entry.count += 1;
    entry.firstPosition = Math.min(entry.firstPosition, match.position);
    byTerm.set(match.term, entry);
  }

  const ordered = [...matches].sort((a, b) => a.position - b.position);

  return {
    version: BRAND_DETECTION_VERSION,
    mentioned: matches.length > 0,
    mentionCount: matches.length,
    firstMentionPosition: ordered.length ? ordered[0].position : null,
    matchedTerms: [...byTerm.values()].sort(
      (a, b) => a.firstPosition - b.firstPosition || a.term.localeCompare(b.term),
    ),
    excludedMatchCount: excludedSpans.length,
  };
}
