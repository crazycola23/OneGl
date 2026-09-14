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
    for (let index = 0; index < run.length - 1; index += 1) {
      units.add(run.slice(index, index + 2));
    }
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

export function wilsonInterval(successes, total, z = 1.96) {
  const n = Number(total);
  const x = Number(successes);
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(x)) return [null, null];
  const p = x / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const margin =
    (z / denominator) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

export function candidateFeatures(row) {
  const title = String(row?.title ?? "").trim();
  const summary = String(row?.summary ?? "").trim();
  const sourceName = String(row?.sourceName ?? row?.source_name ?? "").trim();
  const queries = Array.isArray(row?.queries) ? row.queries.filter(Boolean) : [];
  const prompt = row?.prompt ?? "";

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
    article_retrieval_frequency: bucketRetrievalFrequency(
      row?.articleRetrievals ?? row?.article_retrievals,
    ),
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

  return {
    summary: {
      candidates: total,
      cited,
      baselineRate,
    },
    factors: factorRows,
  };
}

export function rankFactorSignals(analysis, { minN = 20 } = {}) {
  const rows = Array.isArray(analysis?.factors) ? analysis.factors : [];
  return rows
    .filter((row) => row.candidates >= minN && row.uplift != null)
    .map((row) => ({ ...row, signalStrength: Math.abs(row.uplift) }))
    .sort((a, b) => b.signalStrength - a.signalStrength || b.candidates - a.candidates);
}
