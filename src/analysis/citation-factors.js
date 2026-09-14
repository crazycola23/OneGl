const FACTOR_ORDER = [
  "candidate_position",
  "title_prompt_overlap",
  "title_query_overlap",
  "summary_prompt_overlap",
  "title_present",
  "summary_present",
  "source_name_present",
  "search_query_count",
  "article_retrieval_frequency",
  "page_text_length",
  "page_h2_count",
  "page_table_present",
  "page_list_present",
  "page_faq_heading_signal",
  "page_article_schema",
  "page_faq_schema",
  "page_author_signal",
  "page_modified_date_signal",
  "page_noindex_signal",
  "page_numeric_density",
  "page_external_links",
];

const BUCKET_ORDER = {
  candidate_position: ["1", "2", "3", "4-5", "6-10", "11+"],
  title_prompt_overlap: ["missing", "0", "low", "medium", "high"],
  title_query_overlap: ["missing", "0", "low", "medium", "high"],
  summary_prompt_overlap: ["missing", "0", "low", "medium", "high"],
  title_present: ["yes", "no"],
  summary_present: ["yes", "no"],
  source_name_present: ["yes", "no"],
  search_query_count: ["0", "1", "2", "3-4", "5+"],
  article_retrieval_frequency: ["1", "2-3", "4-9", "10+"],
  page_text_length: ["missing", "<1k", "1k-5k", "5k-15k", "15k+"],
  page_h2_count: ["missing", "0", "1-2", "3-5", "6+"],
  page_table_present: ["missing", "yes", "no"],
  page_list_present: ["missing", "yes", "no"],
  page_faq_heading_signal: ["missing", "yes", "no"],
  page_article_schema: ["missing", "yes", "no"],
  page_faq_schema: ["missing", "yes", "no"],
  page_author_signal: ["missing", "yes", "no"],
  page_modified_date_signal: ["missing", "yes", "no"],
  page_noindex_signal: ["missing", "yes", "no"],
  page_numeric_density: ["missing", "0", "low", "medium", "high"],
  page_external_links: ["missing", "0", "1-4", "5-14", "15+"],
};

function normalize(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase().trim();
}

export function lexicalUnits(value) {
  const text = normalize(value);
  if (!text) return new Set();

  const units = new Set();
  for (const token of text.match(/[a-z0-9][a-z0-9._+-]*/gi) ?? []) {
    if (token.length >= 2 || /^\d+$/.test(token)) units.add(token);
  }

  for (const run of text.match(/[\p{Script=Han}]+/gu) ?? []) {
    if (run.length === 1) {
      units.add(run);
      continue;
    }
    for (let index = 0; index < run.length - 1; index += 1) units.add(run.slice(index, index + 2));
  }

  return units;
}

export function diceSimilarity(left, right) {
  const a = lexicalUnits(left);
  const b = lexicalUnits(right);
  if (!a.size || !b.size) return null;

  let intersection = 0;
  for (const unit of a) if (b.has(unit)) intersection += 1;
  return (2 * intersection) / (a.size + b.size);
}

export function maxDiceSimilarity(value, candidates) {
  let best = null;
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const score = diceSimilarity(value, candidate);
    if (score == null) continue;
    best = best == null ? score : Math.max(best, score);
  }
  return best;
}

export function bucketSimilarity(score, hasValue = true) {
  if (!hasValue || score == null) return "missing";
  if (score === 0) return "0";
  if (score < 0.2) return "low";
  if (score < 0.5) return "medium";
  return "high";
}

export function bucketPosition(value) {
  const position = Number(value);
  if (!Number.isFinite(position) || position <= 1) return "1";
  if (position === 2) return "2";
  if (position === 3) return "3";
  if (position <= 5) return "4-5";
  if (position <= 10) return "6-10";
  return "11+";
}

export function bucketSearchQueryCount(value) {
  const count = Number(value ?? 0);
  if (count <= 0) return "0";
  if (count === 1) return "1";
  if (count === 2) return "2";
  if (count <= 4) return "3-4";
  return "5+";
}

export function bucketRetrievalFrequency(value) {
  const count = Math.max(1, Number(value ?? 1));
  if (count <= 1) return "1";
  if (count <= 3) return "2-3";
  if (count <= 9) return "4-9";
  return "10+";
}

function pageAvailable(row) {
  return (row?.pageEvidenceState ?? row?.page_evidence_state) === "success";
}

function yesNo(value, available) {
  if (!available) return "missing";
  return value ? "yes" : "no";
}

export function bucketPageTextLength(value, available = true) {
  if (!available || !Number.isFinite(Number(value))) return "missing";
  const count = Number(value);
  if (count < 1000) return "<1k";
  if (count < 5000) return "1k-5k";
  if (count < 15000) return "5k-15k";
  return "15k+";
}

export function bucketPageH2Count(value, available = true) {
  if (!available || !Number.isFinite(Number(value))) return "missing";
  const count = Number(value);
  if (count <= 0) return "0";
  if (count <= 2) return "1-2";
  if (count <= 5) return "3-5";
  return "6+";
}

export function bucketPageNumericDensity(value, available = true) {
  if (!available || !Number.isFinite(Number(value))) return "missing";
  const density = Number(value);
  if (density <= 0) return "0";
  if (density < 5) return "low";
  if (density < 15) return "medium";
  return "high";
}

export function bucketExternalLinks(value, available = true) {
  if (!available || !Number.isFinite(Number(value))) return "missing";
  const count = Number(value);
  if (count <= 0) return "0";
  if (count <= 4) return "1-4";
  if (count <= 14) return "5-14";
  return "15+";
}

export function wilsonInterval(successes, total, z = 1.96) {
  const n = Number(total);
  const x = Number(successes);
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(x)) return [null, null];
  const p = x / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const margin = (z / denominator) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

export function candidateFeatures(row) {
  const title = String(row?.title ?? "").trim();
  const summary = String(row?.summary ?? "").trim();
  const sourceName = String(row?.sourceName ?? row?.source_name ?? "").trim();
  const queries = Array.isArray(row?.queries) ? row.queries.filter(Boolean) : [];
  const prompt = row?.prompt ?? "";
  const page = pageAvailable(row);

  const titlePrompt = title ? diceSimilarity(title, prompt) : null;
  const titleQuery = title ? maxDiceSimilarity(title, queries) : null;
  const summaryPrompt = summary ? diceSimilarity(summary, prompt) : null;

  return {
    candidate_position: bucketPosition(row?.sourcePosition ?? row?.source_position),
    title_prompt_overlap: bucketSimilarity(titlePrompt, Boolean(title)),
    title_query_overlap: bucketSimilarity(titleQuery, Boolean(title) && queries.length > 0),
    summary_prompt_overlap: bucketSimilarity(summaryPrompt, Boolean(summary)),
    title_present: title ? "yes" : "no",
    summary_present: summary ? "yes" : "no",
    source_name_present: sourceName ? "yes" : "no",
    search_query_count: bucketSearchQueryCount(row?.searchQueryCount ?? row?.search_query_count),
    article_retrieval_frequency: bucketRetrievalFrequency(row?.articleRetrievals ?? row?.article_retrievals),
    page_text_length: bucketPageTextLength(row?.pageTextLength ?? row?.page_text_length, page),
    page_h2_count: bucketPageH2Count(row?.pageH2Count ?? row?.page_h2_count, page),
    page_table_present: yesNo(Number(row?.pageTableCount ?? row?.page_table_count ?? 0) > 0, page),
    page_list_present: yesNo(Number(row?.pageListCount ?? row?.page_list_count ?? 0) > 0, page),
    page_faq_heading_signal: yesNo(Number(row?.pageFaqHeadingCount ?? row?.page_faq_heading_count ?? 0) > 0, page),
    page_article_schema: yesNo(Boolean(row?.pageHasArticleSchema ?? row?.page_has_article_schema), page),
    page_faq_schema: yesNo(Boolean(row?.pageHasFaqSchema ?? row?.page_has_faq_schema), page),
    page_author_signal: yesNo(Boolean(row?.pageAuthorPresent ?? row?.page_author_present), page),
    page_modified_date_signal: yesNo(Boolean(row?.pageModifiedAtRaw ?? row?.page_modified_at_raw), page),
    page_noindex_signal: yesNo(Boolean(row?.pageRobotsNoindex ?? row?.page_robots_noindex), page),
    page_numeric_density: bucketPageNumericDensity(row?.pageNumericDensity ?? row?.page_numeric_density, page),
    page_external_links: bucketExternalLinks(row?.pageExternalLinkCount ?? row?.page_external_link_count, page),
  };
}

function bucketIndex(factor, bucket) {
  const order = BUCKET_ORDER[factor] ?? [];
  const index = order.indexOf(bucket);
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

export function analyzeCitationFactors(rows, { minN = 1 } = {}) {
  const candidates = Array.isArray(rows) ? rows : [];
  const total = candidates.length;
  const cited = candidates.filter((row) => Boolean(row?.cited)).length;
  const baselineRate = total ? cited / total : null;
  const groups = new Map();

  for (const row of candidates) {
    const features = candidateFeatures(row);
    for (const [factor, bucket] of Object.entries(features)) {
      const key = `${factor}\u0000${bucket}`;
      const group = groups.get(key) ?? { factor, bucket, candidates: 0, cited: 0 };
      group.candidates += 1;
      if (row?.cited) group.cited += 1;
      groups.set(key, group);
    }
  }

  const factorRows = [...groups.values()]
    .filter((group) => group.candidates >= minN)
    .map((group) => {
      const rate = group.candidates ? group.cited / group.candidates : null;
      const [ciLow, ciHigh] = wilsonInterval(group.cited, group.candidates);
      return {
        ...group,
        rate,
        baselineRate,
        relativeRate: baselineRate && rate != null ? rate / baselineRate : null,
        uplift: baselineRate && rate != null ? rate / baselineRate - 1 : null,
        ciLow,
        ciHigh,
      };
    })
    .sort((left, right) => {
      const factorDelta = FACTOR_ORDER.indexOf(left.factor) - FACTOR_ORDER.indexOf(right.factor);
      if (factorDelta !== 0) return factorDelta;
      return bucketIndex(left.factor, left.bucket) - bucketIndex(right.factor, right.bucket);
    });

  return { summary: { candidates: total, cited, baselineRate }, factors: factorRows };
}

export function rankFactorSignals(analysis, { minN = 20 } = {}) {
  const rows = Array.isArray(analysis?.factors) ? analysis.factors : [];
  return rows
    .filter((row) => row.candidates >= minN && row.uplift != null && row.bucket !== "missing")
    .map((row) => ({ ...row, signalStrength: Math.abs(row.uplift) }))
    .sort((a, b) => b.signalStrength - a.signalStrength || b.candidates - a.candidates);
}

// ---------------------------------------------------------------------------
// Domain-stratified analysis
//
// Candidate rows are not independent observations. One site contributes many URLs,
// and pages from the same site share everything the feature table cannot see
// (authority, topic coverage, being indexed at all). Treating those as independent
// inflates the effective sample size and makes every bucket look more certain than it is.
//
// The functions below answer the question the pooled analysis cannot: does this feature
// still separate cited from uncited *inside the same domain*? A bucket that only wins
// because it is common on authoritative sites collapses here, which is the point.
// ---------------------------------------------------------------------------

function groupByDomain(rows) {
  const byDomain = new Map();
  for (const row of rows) {
    const domain = row?.domain || "unknown";
    const list = byDomain.get(domain) ?? [];
    list.push(row);
    byDomain.set(domain, list);
  }
  return byDomain;
}

function rankWithTies(values) {
  const sorted = values
    .map((value, index) => ({ value, index }))
    .sort((left, right) => left.value - right.value);
  const ranks = new Array(values.length).fill(0);
  let position = 0;
  while (position < sorted.length) {
    let end = position;
    while (end + 1 < sorted.length && sorted[end + 1].value === sorted[position].value) end += 1;
    const averageRank = (position + end) / 2 + 1;
    for (let cursor = position; cursor <= end; cursor += 1) ranks[sorted[cursor].index] = averageRank;
    position = end + 1;
  }
  return ranks;
}

function normalQuantile(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lower = 0.02425;
  const upper = 1 - lower;
  if (p < lower) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > upper) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export function normalTwoSidedP(z) {
  const value = Number(z);
  if (!Number.isFinite(value)) return null;
  const x = Math.abs(value);
  const t = 1 / (1 + 0.2316419 * x);
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const tail = poly * Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
  return Math.max(0, Math.min(1, 2 * tail));
}

/**
 * Wilcoxon signed-rank test over per-domain paired differences.
 *
 * Each domain contributes one pair: (rate inside the bucket, rate outside the bucket
 * within that same domain). Domains that contain only the bucket or only the
 * complement carry no information about the difference and are dropped, so the test
 * cannot be carried by a single site's volume.
 */
export function pairedDomainPValue(pairs) {
  const usable = (Array.isArray(pairs) ? pairs : []).filter((pair) => {
    const difference = Number(pair?.difference);
    return Number.isFinite(difference) && difference !== 0;
  });
  const n = usable.length;
  if (n < 3) return { pValue: null, n, z: null, note: "too-few-paired-domains" };

  const ranks = rankWithTies(usable.map((pair) => Math.abs(Number(pair.difference))));
  let positive = 0;
  let negative = 0;
  for (let index = 0; index < usable.length; index += 1) {
    if (Number(usable[index].difference) > 0) positive += ranks[index];
    else negative += ranks[index];
  }
  const w = Math.min(positive, negative);
  const totalRanks = (n * (n + 1)) / 2;
  const mean = totalRanks / 2;
  // Tie correction for the variance of the signed-rank statistic.
  const tieGroups = new Map();
  for (const pair of usable) {
    const key = Math.abs(Number(pair.difference));
    tieGroups.set(key, (tieGroups.get(key) ?? 0) + 1);
  }
  let tieSum = 0;
  for (const size of tieGroups.values()) tieSum += size ** 3 - size;
  const variance = (n * (n + 1) * (2 * n + 1)) / 24 - tieSum / 48;

  // Degenerate case: every domain shows the *same* difference. That is maximal
  // consistency, not absence of evidence, but the signed-rank statistic has no
  // variance left to stand on. It is reported as degenerate and the decision is
  // carried by the direction-consistency rule instead of by a fake p-value.
  if (!(variance > 0)) {
    return { pValue: null, n, z: null, note: "degenerate-all-tied" };
  }
  const z = (w - mean) / Math.sqrt(variance);
  return { pValue: normalTwoSidedP(z), n, z, note: null };
}

/**
 * Design effect for clustered data: how many independent observations the domain
 * structure actually buys. n_eff = n / (1 + (m-1) * ICC) with a conservative ICC
 * derived from the between-domain spread of citation rates.
 */
/**
 * Design effect for clustered data: how many independent observations the domain
 * structure actually buys.
 *
 * ICC is estimated from a binomial variance decomposition rather than supplied as a
 * guess: with y_ij the citation indicator of row j in domain i, the within-domain
 * variance p(1-p) is what independent rows would give, and anything above it is
 * between-domain structure. When every domain has the same citation rate the ICC is 0
 * (correctly - there is nothing site-specific to correct for), and it grows as sites
 * diverge.
 */
export function designEffect({ rows, domainRateVariance = 0 }) {
  const candidates = Array.isArray(rows) ? rows : [];
  const byDomain = groupByDomain(candidates);
  const domainCount = byDomain.size;
  if (!candidates.length || domainCount < 2) {
    return { nEff: candidates.length, domainCount: domainCount || 0, icc: 0 };
  }

  const overallRate = candidates.filter((row) => row?.cited).length / candidates.length;
  // Variance decomposition for a binary outcome: the total variance of the citation
  // indicator is p(1-p); a 1/(1-p) share of it sits *between* domains when the observed
  // between-domain spread exceeds what independent Bernoulli draws would produce.
  const total = overallRate * (1 - overallRate);
  const between = Math.max(0, Number(domainRateVariance) || 0);
  const icc = total > 0 && between > 0 ? Math.max(0, Math.min(1, between / total)) : 0;

  const meanClusterSize = candidates.length / domainCount;
  const deff = 1 + (meanClusterSize - 1) * icc;
  return {
    nEff: Math.round(candidates.length / (deff || 1)),
    domainCount,
    meanClusterSize: Number(meanClusterSize.toFixed(2)),
    icc: Number(icc.toFixed(4)),
    designEffect: Number(deff.toFixed(3)),
  };
}

function binomialVariance(rate, n) {
  if (!Number.isFinite(rate) || !(n > 0)) return 0;
  return (rate * (1 - rate)) / n;
}

export function analyzeCitationFactorsStratified(rows, { factorRows = null, rowsForFactor = null } = {}) {
  const candidates = Array.isArray(rows) ? rows : [];
  const byDomain = groupByDomain(candidates);
  const domainRates = [...byDomain.values()].map((list) => (list.length ? list.filter((row) => row?.cited).length / list.length : 0));
  const overallRate = domainRates.length ? domainRates.reduce((sum, value) => sum + value, 0) / domainRates.length : 0;
  // Between-domain variance of citation rates is what makes two candidates from two
  // sites non-exchangeable; it is a deliberately shallow substitute for a full ICC
  // estimate, which needs repeated measures per domain.
  const domainVariance = domainRates.length > 1
    ? domainRates.reduce((sum, value) => sum + (value - overallRate) ** 2, 0) / (domainRates.length - 1)
    : 0;

  const pick = typeof rowsForFactor === "function" ? rowsForFactor : (row) => (factorRows ? factorRows(row) : null);
  const out = [];
  for (const factorRow of Array.isArray(factorRows) ? factorRows : []) {
    const bucketOf = (row) => pick(row)?.[factorRow.factor];
    let candidateCount = 0;
    let citedCount = 0;
    let observed = 0;
    const domains = new Set();
    const pairs = [];

    for (const [domain, list] of byDomain) {
      let inside = 0;
      let insideCited = 0;
      let outside = 0;
      let outsideCited = 0;
      for (const row of list) {
        const matches = bucketOf(row) === factorRow.bucket;
        const cited = Boolean(row?.cited);
        if (matches) {
          inside += 1;
          observed += 1;
          if (cited) insideCited += 1;
        } else {
          outside += 1;
          if (cited) outsideCited += 1;
        }
      }
      candidateCount += inside;
      citedCount += insideCited;
      if (inside > 0) domains.add(domain);
      if (inside > 0 && outside > 0) {
        const insideRate = insideCited / inside;
        const outsideRate = outsideCited / outside;
        pairs.push({
          domain,
          inside,
          outside,
          insideRate,
          outsideRate,
          difference: insideRate - outsideRate,
          differenceVariance: binomialVariance(insideRate, inside) + binomialVariance(outsideRate, outside),
        });
      }
    }

    // Every domain is one observation, regardless of how many rows it contributed.
    // Inverse-variance weighting would let one large site decide the answer, which is the
    // very failure mode this analysis exists to prevent.
    const paired = pairs.filter((pair) => pair.differenceVariance >= 0);
    const meanDifference = paired.length
      ? paired.reduce((sum, pair) => sum + pair.difference, 0) / paired.length
      : null;
    const differenceVariance = paired.length > 1 && meanDifference != null
      ? paired.reduce((sum, pair) => sum + (pair.difference - meanDifference) ** 2, 0) / (paired.length - 1)
      : null;
    const standardError = paired.length > 1 && differenceVariance != null
      ? Math.sqrt(differenceVariance / paired.length)
      : null;
    const weightedDifference = meanDifference;
    const test = pairedDomainPValue(pairs);

    out.push({
      factor: factorRow.factor,
      bucket: factorRow.bucket,
      candidates: candidateCount,
      cited: citedCount,
      rate: candidateCount ? citedCount / candidateCount : null,
      pooledUplift: factorRow.uplift,
      observedCandidateShare: candidates.length ? observed / candidates.length : null,
      domains: domains.size,
      pairedDomains: test.n,
      withinDomainDifference: weightedDifference,
      withinDomainCiLow: weightedDifference != null && standardError != null ? weightedDifference - 1.96 * standardError : null,
      withinDomainCiHigh: weightedDifference != null && standardError != null ? weightedDifference + 1.96 * standardError : null,
      withinDomainPValue: test.pValue,
      withinDomainNote: test.note,
      domainsWithPositiveDifference: pairs.filter((pair) => pair.difference > 0).length,
      domainsWithNegativeDifference: pairs.filter((pair) => pair.difference < 0).length,
      directionConsistent:
        pairs.length >= 3 &&
        (pairs.filter((pair) => pair.difference > 0).length >= Math.ceil(pairs.length * 0.8) ||
          pairs.filter((pair) => pair.difference < 0).length >= Math.ceil(pairs.length * 0.8)),
    });
  }

  return {
    domains: byDomain.size,
    domainRateVariance: domainVariance,
    design: designEffect({ rows: candidates, domainRateVariance: domainVariance }),
    factors: out,
  };
}
