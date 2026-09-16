const QUERY_UNAVAILABLE = "unavailable";

const STOPWORDS = new Set([
  "的", "了", "是", "在", "和", "与", "或", "有", "没有", "一个", "哪些", "什么", "怎么", "如何",
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are", "what", "which", "how",
]);

const segmenter = typeof Intl?.Segmenter === "function"
  ? new Intl.Segmenter("zh-CN", { granularity: "word" })
  : null;

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

export function tokenizeFanout(value) {
  const text = normalizeText(value);
  if (!text) return [];

  let tokens;
  if (segmenter) {
    tokens = [...segmenter.segment(text)]
      .filter((part) => part.isWordLike)
      .map((part) => part.segment.toLocaleLowerCase());
  } else {
    tokens = text.match(/[\p{Script=Han}]+|[a-z0-9]+/giu) ?? [];
  }

  return tokens
    .map((token) => token.replace(/^\p{P}+|\p{P}+$/gu, "").trim())
    .filter((token) => token && !STOPWORDS.has(token));
}

function bump(map, key, count = 1) {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + count);
}

function statList(map, total, limit = 50) {
  return [...map.entries()]
    .map(([term, count]) => ({ term, count, share: total ? count / total : 0 }))
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term, "zh-CN"))
    .slice(0, limit);
}

/**
 * Query fan-out = the real web searches an answer engine issues while answering
 * a tracked prompt. Rows are run-level observations, not synthetic keywords.
 */
export function computeQueryFanout(rows = [], { promptRunCounts = new Map(), limit = 25 } = {}) {
  const overall = new Map();
  const byPrompt = new Map();
  const terms = new Map();
  const added = new Map();
  const dropped = new Map();
  const preserved = new Map();
  let totalQueries = 0;
  let brandQueryHits = 0;

  for (const raw of rows) {
    const query = normalizeText(raw.query ?? raw.query_text);
    const prompt = String(raw.prompt ?? "").trim();
    const promptId = String(raw.promptId ?? raw.prompt_id ?? "").trim();
    if (!query || query === QUERY_UNAVAILABLE || query === normalizeText(prompt)) continue;

    const weight = Math.max(1, Number(raw.count ?? 1) || 1);
    const brandHits = raw.brandMentions != null
      ? Number(raw.brandMentions) || 0
      : raw.brand_mentioned === true
        ? weight
        : 0;
    totalQueries += weight;
    brandQueryHits += brandHits;

    const overallEntry = overall.get(query) ?? { count: 0, brandMentions: 0, promptIds: new Set() };
    overallEntry.count += weight;
    overallEntry.brandMentions += brandHits;
    if (promptId) overallEntry.promptIds.add(promptId);
    overall.set(query, overallEntry);

    const promptEntry = byPrompt.get(promptId) ?? {
      promptId,
      prompt,
      totalQueries: 0,
      queries: new Map(),
    };
    promptEntry.totalQueries += weight;
    const local = promptEntry.queries.get(query) ?? { count: 0, brandMentions: 0 };
    local.count += weight;
    local.brandMentions += brandHits;
    promptEntry.queries.set(query, local);
    byPrompt.set(promptId, promptEntry);

    const queryTokens = new Set(tokenizeFanout(query));
    const promptTokens = new Set(tokenizeFanout(prompt));
    for (const token of queryTokens) {
      bump(terms, token, weight);
      bump(promptTokens.has(token) ? preserved : added, token, weight);
    }
    for (const token of promptTokens) {
      if (!queryTokens.has(token)) bump(dropped, token, weight);
    }
  }

  const topQueries = [...overall.entries()]
    .map(([query, value]) => ({
      query,
      count: value.count,
      prompts: value.promptIds.size,
      brandMentionRate: value.count ? value.brandMentions / value.count : null,
    }))
    .sort((a, b) => b.count - a.count || b.prompts - a.prompts || a.query.localeCompare(b.query, "zh-CN"))
    .slice(0, limit);

  const promptRows = [...byPrompt.values()]
    .map((entry) => {
      const runs = Number(promptRunCounts.get(entry.promptId) ?? 0);
      return {
        promptId: entry.promptId,
        prompt: entry.prompt,
        totalQueries: entry.totalQueries,
        uniqueQueries: entry.queries.size,
        runs,
        avgPerRun: runs ? entry.totalQueries / runs : null,
        variations: [...entry.queries.entries()]
          .map(([query, value]) => ({
            query,
            count: value.count,
            brandMentionRate: value.count ? value.brandMentions / value.count : null,
          }))
          .sort((a, b) => b.count - a.count || a.query.localeCompare(b.query, "zh-CN"))
          .slice(0, 15),
      };
    })
    .sort((a, b) => b.totalQueries - a.totalQueries || a.prompt.localeCompare(b.prompt, "zh-CN"));

  return {
    totalQueries,
    uniqueQueries: overall.size,
    coverageRate: totalQueries ? brandQueryHits / totalQueries : null,
    topQueries,
    terms: statList(terms, totalQueries, 60),
    wordChanges: {
      added: statList(added, totalQueries, 60),
      dropped: statList(dropped, totalQueries, 60),
      preserved: statList(preserved, totalQueries, 60),
    },
    byPrompt: promptRows,
  };
}

function bucketDomainsByDay(rows = []) {
  const days = new Map();
  for (const row of rows) {
    const date = String(row.date ?? "").slice(0, 10);
    const domain = normalizeText(row.domain);
    const count = Math.max(0, Number(row.count ?? 0) || 0);
    if (!date || !domain || !count) continue;
    const bucket = days.get(date) ?? new Map();
    bucket.set(domain, (bucket.get(domain) ?? 0) + count);
    days.set(date, bucket);
  }
  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, counts]) => ({
      date,
      counts,
      total: [...counts.values()].reduce((sum, count) => sum + count, 0),
    }));
}

/** Citation source churn. Set volatility uses Jaccard distance; weighted volatility
 * uses overlap of normalized citation-volume vectors (equivalent to Bray-Curtis here). */
export function computeCitationVolatility(rows = []) {
  const days = bucketDomainsByDay(rows);
  if (days.length < 2) {
    return { setVolatility: null, weightedVolatility: null, stabilityScore: null, transitions: 0 };
  }

  let setTotal = 0;
  let weightedTotal = 0;
  for (let index = 1; index < days.length; index += 1) {
    const previous = days[index - 1];
    const current = days[index];
    let intersection = 0;
    for (const domain of current.counts.keys()) {
      if (previous.counts.has(domain)) intersection += 1;
    }
    const union = current.counts.size + previous.counts.size - intersection;
    setTotal += union ? 1 - intersection / union : 0;

    let overlap = 0;
    for (const [domain, count] of current.counts) {
      const previousCount = previous.counts.get(domain);
      if (previousCount == null) continue;
      overlap += Math.min(count / current.total, previousCount / previous.total);
    }
    weightedTotal += 1 - overlap;
  }

  const transitions = days.length - 1;
  const setVolatility = round(setTotal / transitions);
  const weightedVolatility = round(weightedTotal / transitions);
  return {
    setVolatility,
    weightedVolatility,
    stabilityScore: Math.round((1 - Math.max(0, Math.min(1, weightedVolatility))) * 100),
    transitions,
  };
}

export function citationDifficulty(stabilityScore) {
  if (stabilityScore == null) return "insufficient-data";
  if (stabilityScore < 40) return "wide-open";
  if (stabilityScore < 70) return "contested";
  return "locked-in";
}

/** Share of voice is calculated over comparable entity-mention units. A run may
 * mention more than one competitor, so the denominator is mentions, not runs. */
export function computeShareOfVoice(brand, competitors = []) {
  const brandMentions = Math.max(0, Number(brand?.mentions ?? 0) || 0);
  const normalized = competitors.map((item) => ({
    name: String(item.name ?? "").trim(),
    mentions: Math.max(0, Number(item.mentions ?? 0) || 0),
  })).filter((item) => item.name);
  const total = brandMentions + normalized.reduce((sum, item) => sum + item.mentions, 0);
  const rows = [
    { name: String(brand?.name ?? "Brand"), mentions: brandMentions, isBrand: true },
    ...normalized.map((item) => ({ ...item, isBrand: false })),
  ].map((item) => ({ ...item, share: total ? item.mentions / total : 0 }))
    .sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name, "zh-CN"));
  return { totalMentions: total, brandShare: total ? brandMentions / total : null, entries: rows };
}

/** Deterministic opportunity candidates. These are evidence summaries, not an LLM
 * making unsupported page-edit claims; a future narrative layer can consume them. */
export function buildGeoOpportunities(input = {}) {
  const opportunities = [];
  const fanout = input.fanout ?? {};
  const promptGaps = Array.isArray(input.promptGaps) ? input.promptGaps : [];
  const topDomains = Array.isArray(input.topDomains) ? input.topDomains : [];
  const stability = input.stability ?? {};

  for (const gap of promptGaps.filter((row) => Number(row.gap) >= 0.2).slice(0, 5)) {
    opportunities.push({
      category: "competitive-gap",
      priority: Number(gap.gap),
      title: `缩小「${gap.prompt}」的竞品提及差距`,
      why: `${gap.competitor} 的提及率高于目标品牌 ${Math.round(Number(gap.gap) * 100)} 个百分点。`,
      evidence: { promptId: gap.promptId, competitor: gap.competitor, gap: Number(gap.gap) },
    });
  }

  for (const query of (fanout.topQueries ?? []).filter((row) => (row.brandMentionRate ?? 1) < 0.5).slice(0, 5)) {
    opportunities.push({
      category: "query-coverage",
      priority: query.count * (1 - (query.brandMentionRate ?? 0)),
      title: `覆盖高频搜索改写「${query.query}」`,
      why: `该搜索改写出现 ${query.count} 次，但对应回答中的品牌提及率只有 ${Math.round((query.brandMentionRate ?? 0) * 100)}%。`,
      evidence: { query: query.query, count: query.count, brandMentionRate: query.brandMentionRate },
    });
  }

  if (stability.stabilityScore != null && stability.stabilityScore < 50 && Number(input.visibilityRate ?? 1) < 0.5) {
    opportunities.push({
      category: "source-landscape",
      priority: 1,
      title: "优先攻克来源仍在轮换的问题集",
      why: `引用来源稳定度为 ${stability.stabilityScore}/100，来源仍频繁变化，同时品牌可见率偏低。`,
      evidence: { ...stability, difficulty: citationDifficulty(stability.stabilityScore) },
    });
  }

  for (const domain of topDomains.slice(0, 5)) {
    if ((Number(domain.share) || 0) < 0.1) continue;
    opportunities.push({
      category: "source-surface",
      priority: Number(domain.share),
      title: `研究高权重引用来源 ${domain.domain}`,
      why: `${domain.domain} 占本批次可见引用约 ${Math.round(Number(domain.share) * 100)}%，值得结合真实页面证据评估可进入路径。`,
      evidence: { domain: domain.domain, share: Number(domain.share), citations: Number(domain.citations ?? 0) },
    });
  }

  return opportunities
    .sort((a, b) => b.priority - a.priority || a.title.localeCompare(b.title, "zh-CN"))
    .slice(0, 12);
}
