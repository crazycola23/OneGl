function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function ratio(numerator, denominator) {
  const bottom = toNumber(denominator);
  if (bottom <= 0) return null;
  return toNumber(numerator) / bottom;
}

function optionalRate(value, numerator, denominator) {
  if (value != null && value !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return ratio(numerator, denominator);
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function score100(value) {
  return Math.round(clamp(value) * 100);
}

function average(values) {
  const usable = values.filter((value) => Number.isFinite(value));
  if (!usable.length) return null;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

function grade(score) {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "E";
}

function tone(score) {
  if (score >= 80) return "good";
  if (score >= 60) return "warn";
  return "bad";
}

function normalizeSourceDistribution(detail) {
  const total = toNumber(detail?.report?.citations?.total ?? detail?.sources?.totals?.citations);
  const rows = Array.isArray(detail?.sources?.domains)
    ? detail.sources.domains
    : Array.isArray(detail?.report?.topDomains)
      ? detail.report.topDomains
      : [];
  const buckets = rows
    .map((row) => ({ domain: row.domain ?? "(unknown)", citations: toNumber(row.citations) }))
    .filter((row) => row.citations > 0);
  const known = buckets.reduce((sum, row) => sum + row.citations, 0);
  const other = Math.max(0, total - known);
  if (other > 0) buckets.push({ domain: "其它域名", citations: other });
  return { total, buckets };
}

function sourceMetrics(detail) {
  const { total, buckets } = normalizeSourceDistribution(detail);
  if (!total || !buckets.length) {
    return {
      topDomainShare: null,
      hhi: null,
      effectiveDomains: 0,
      diversityScore: 0,
      concentrationLabel: "暂无引用数据",
    };
  }
  const shares = buckets.map((row) => row.citations / total);
  const topDomainShare = Math.max(...shares);
  const hhi = shares.reduce((sum, share) => sum + share * share, 0);
  const effectiveDomains = hhi > 0 ? 1 / hhi : 0;
  const diversityScore = score100(
    0.55 * clamp(1 - topDomainShare) + 0.45 * clamp(effectiveDomains / 6),
  );
  const concentrationLabel =
    topDomainShare >= 0.6 || hhi >= 0.35
      ? "高度集中"
      : topDomainShare >= 0.4 || hhi >= 0.22
        ? "中度集中"
        : "相对分散";
  return { topDomainShare, hhi, effectiveDomains, diversityScore, concentrationLabel };
}

function citationCompleteness(detail) {
  const runs = Array.isArray(detail?.runs) ? detail.runs : [];
  let expected = 0;
  let captured = 0;
  let comparable = 0;
  for (const run of runs) {
    const e = Number(run.expected_citation_count ?? run.expectedCitationCount);
    const c = Number(run.captured_citation_count ?? run.capturedCitationCount);
    if (!Number.isFinite(e) || e < 0 || !Number.isFinite(c) || c < 0) continue;
    if (e === 0) continue;
    expected += e;
    captured += Math.min(c, e);
    comparable += 1;
  }
  return {
    comparableRuns: comparable,
    expected,
    captured,
    rate: expected > 0 ? captured / expected : null,
  };
}

function categoryMetrics(detail) {
  const rows = Array.isArray(detail?.report?.byCategory) ? detail.report.byCategory : [];
  const normalized = rows
    .map((row) => ({
      category: row.category ?? "uncategorized",
      validRuns: toNumber(row.validRuns),
      mentioned: toNumber(row.mentioned),
      mentionRate: optionalRate(row.mentionRate, row.mentioned, row.validRuns),
    }))
    .filter((row) => row.validRuns > 0 && row.mentionRate != null);
  if (!normalized.length) return { rows: [], best: null, weakest: null, gap: null };
  const sorted = [...normalized].sort((a, b) => b.mentionRate - a.mentionRate);
  return {
    rows: normalized,
    best: sorted[0],
    weakest: sorted.at(-1),
    gap: sorted[0].mentionRate - sorted.at(-1).mentionRate,
  };
}

function accountMetrics(detail) {
  const rows = Array.isArray(detail?.report?.byAccount) ? detail.report.byAccount : [];
  const rates = rows
    .map((row) => ({ account: row.account, rate: optionalRate(row.mentionRate, row.mentioned, row.validRuns) }))
    .filter((row) => row.rate != null && Number.isFinite(row.rate));
  if (rates.length < 2) return { gap: null, highest: null, lowest: null };
  const sorted = [...rates].sort((a, b) => b.rate - a.rate);
  return { gap: sorted[0].rate - sorted.at(-1).rate, highest: sorted[0], lowest: sorted.at(-1) };
}

function factorEvidenceMetrics(detail) {
  const factor = detail?.report?.citationFactors ?? detail?.citationFactors ?? null;
  if (!factor || factor.available === false) {
    return {
      available: false,
      reason: factor?.message ?? "暂无候选→引用因子数据",
      candidates: 0,
      cited: 0,
      baselineRate: null,
      pageEvidenceRate: null,
      supportedSignals: [],
      positiveSignals: [],
      negativeSignals: [],
      evidenceScore: 0,
      evidenceLabel: "未就绪",
      gate: factor?.evidenceGate ?? null,
      matchCoverage: factor?.matchCoverage ?? null,
    };
  }

  const candidates = toNumber(factor?.cohort?.candidates);
  const cited = toNumber(factor?.cohort?.cited);
  const baselineRate = optionalRate(factor?.cohort?.baselineRate, cited, candidates);
  const pageEvidenceRate = optionalRate(
    factor?.pageEvidence?.successRate,
    factor?.pageEvidence?.successfulArticles,
    factor?.pageEvidence?.totalArticles,
  );
  const signals = Array.isArray(factor?.strongestSignals) ? factor.strongestSignals : [];
  const supportedSignals = signals.filter(
    (row) => row.bucket !== "missing" && Number.isFinite(Number(row.qValue)) && Number(row.qValue) <= 0.1 && toNumber(row.candidates) >= 30,
  );
  const positiveSignals = supportedSignals.filter((row) => Number(row.uplift) > 0).slice(0, 5);
  const negativeSignals = supportedSignals.filter((row) => Number(row.uplift) < 0).slice(0, 5);

  const samplePart = clamp(candidates / 300);
  const pagePart = pageEvidenceRate == null ? 0 : clamp(pageEvidenceRate);
  const supportPart = clamp(supportedSignals.length / 3);
  const evidenceScore = score100(0.45 * samplePart + 0.35 * pagePart + 0.2 * supportPart);
  const evidenceLabel = evidenceScore >= 80 ? "较强" : evidenceScore >= 60 ? "中等" : evidenceScore >= 35 ? "探索性" : "不足";

  return {
    available: true,
    candidates,
    cited,
    baselineRate,
    pageEvidenceRate,
    pageEvidenceArticles: toNumber(factor?.pageEvidence?.totalArticles),
    pageEvidenceSuccessful: toNumber(factor?.pageEvidence?.successfulArticles),
    supportedSignals,
    positiveSignals,
    negativeSignals,
    evidenceScore,
    evidenceLabel,
    gate: factor?.evidenceGate ?? null,
    matchCoverage: factor?.matchCoverage ?? null,
  };
}

function priority(level, title, evidence, direction, metric) {
  return { level, title, evidence, direction, metric };
}

function signalDescription(row) {
  const label = row.factorLabel ?? row.factor ?? "页面因素";
  const uplift = Number(row.uplift);
  const q = Number(row.qValue);
  return `${label}=${row.bucket}（n=${toNumber(row.candidates)}，uplift ${uplift >= 0 ? "+" : ""}${(uplift * 100).toFixed(0)}%，q=${Number.isFinite(q) ? q.toFixed(3) : "n/a"}）`;
}

function buildRecommendations(metrics) {
  const items = [];
  const citationCoverageEvidence = metrics.citationEvidenceRate == null
    ? ""
    : `；引用证据覆盖 ${(metrics.citationEvidenceRate * 100).toFixed(1)}%`;

  if (metrics.dataQualityScore < 80) {
    items.push(
      priority(
        "P0",
        "先提升数据可信度，再放大战略结论",
        `数据质量评分 ${metrics.dataQualityScore}/100；有效样本率 ${(metrics.validRate * 100).toFixed(1)}%${citationCoverageEvidence}。`,
        "优先处理失败 Run、未确认新会话和引用解析不完整；对无效样本补跑，不把失败样本混入业务结论。",
        "目标：数据质量评分 ≥ 85，有效样本率 ≥ 90%，引用证据覆盖 ≥ 90%",
      ),
    );
  }

  if (
    metrics.citationEvidenceRate != null &&
    metrics.citationEvidenceRate < 0.8 &&
    metrics.dataQualityScore >= 80
  ) {
    items.push(
      priority(
        "P0",
        "先补齐引用证据覆盖，再解释引用变化",
        `只有 ${(metrics.citationEvidenceRate * 100).toFixed(1)}% 的 answer-valid Run 具备完整引用证据（${metrics.citationValidRuns}/${metrics.valid}）。`,
        "优先补跑 citation parse/reconciliation 失败的 Run；在覆盖恢复前，不把引用数、来源分布或引用密度变化解释成豆包行为变化。",
        "目标：引用证据覆盖 ≥ 90%，再比较引用密度和来源结构",
      ),
    );
  }

  if (metrics.factorEvidence.available && metrics.factorEvidence.pageEvidenceRate != null && metrics.factorEvidence.pageEvidenceRate < 0.7) {
    items.push(
      priority(
        "P0",
        "先提高候选页面证据覆盖，再解释页面因素",
        `候选页面证据成功率仅 ${(metrics.factorEvidence.pageEvidenceRate * 100).toFixed(1)}%（${metrics.factorEvidence.pageEvidenceSuccessful}/${metrics.factorEvidence.pageEvidenceArticles}）。`,
        "先定位 blocked、non_html、too_large 与编码问题，保证页面因素的 missing 不集中在某些域名/内容类型；覆盖不足时不要把 yes/no bucket 当成总体规律。",
        "目标：页面证据成功率 ≥ 80%，并检查失败是否集中在特定域名",
      ),
    );
  }

  if (metrics.promptCoverage != null && metrics.promptCoverage < 0.4) {
    items.push(
      priority(
        "P1",
        "提高问题池中的自然可见度",
        `PROMPT 级提及覆盖仅 ${(metrics.promptCoverage * 100).toFixed(1)}%。`,
        "围绕低覆盖意图建立可直接回答的问题页/知识块：结论先行、数据可核验、标题与用户问题一致，并优先补齐最弱问题分类。",
        "目标：下一批 PROMPT 覆盖提升 10–15 个百分点",
      ),
    );
  }

  if (metrics.factorEvidence.positiveSignals.length) {
    const top = metrics.factorEvidence.positiveSignals.slice(0, 3);
    items.push(
      priority(
        "P1",
        "把高关联页面信号转成受控验证实验",
        `当前 FDR 校正后仍保留的正向观察包括：${top.map(signalDescription).join("；")}。`,
        "不要直接把这些因素批量应用到所有页面。优先挑自有内容做单变量或小型析因实验：保持主题、域名、正文主体和时间窗尽量一致，只改变一个可控结构信号，再用固定 Prompt 池复测。",
        "目标：至少 2 个独立批次保持同方向，且 q≤0.10；随后再进入多变量/样本外验证",
      ),
    );
  }

  if (metrics.trackedConfigured && metrics.trackedRate != null && metrics.trackedRate < 0.25) {
    items.push(
      priority(
        "P1",
        "提升自有/目标文章进入最终引用层的概率",
        `目标文章被引用率 ${(metrics.trackedRate * 100).toFixed(1)}%。`,
        "优先从已经进入候选池但未进入最终引用的自有内容中选实验对象；结合当前因子证据做受控改版，不把页面因素关联视为平台官方权重。",
        "目标：目标文章引用率提升至当前基线的 1.5×，并记录候选→引用转化变化",
      ),
    );
  }

  if (metrics.source.topDomainShare != null && metrics.source.topDomainShare >= 0.5) {
    items.push(
      priority(
        "P1",
        "降低单一来源依赖，提升来源结构韧性",
        `头部域名占全部引用 ${(metrics.source.topDomainShare * 100).toFixed(1)}%，来源结构${metrics.source.concentrationLabel}。`,
        "增加多类型权威来源覆盖：官方资料、行业媒体、知识型页面与高质量第三方评测；同时观察豆包是否长期依赖单一生态来源。",
        "目标：Top1 域名占比 < 40%，有效来源数持续上升",
      ),
    );
  }

  if (metrics.category.gap != null && metrics.category.gap >= 0.3) {
    items.push(
      priority(
        "P1",
        "优先补齐最弱问题意图",
        `最佳分类与最弱分类提及率相差 ${(metrics.category.gap * 100).toFixed(1)} 个百分点；最弱为「${metrics.category.weakest.category}」。`,
        `把下一轮内容与 Prompt 扩充集中到「${metrics.category.weakest.category}」，同时保留强分类作为对照组，避免平均值掩盖结构性短板。`,
        "目标：分类差距压缩到 20 个百分点以内",
      ),
    );
  }

  if (metrics.account.gap != null && metrics.account.gap >= 0.2) {
    items.push(
      priority(
        "P2",
        "验证账号/个性化差异后再下总体结论",
        `不同账号提及率最大差距 ${(metrics.account.gap * 100).toFixed(1)} 个百分点。`,
        "增加账号数与重复次数，保持相同 Prompt/时间窗，分离账号个性化、随机性与内容本身影响。",
        "目标：扩大重复样本并报告账号间方差",
      ),
    );
  }

  if (metrics.citationDensity != null && metrics.citationDensity < 1) {
    items.push(
      priority(
        "P2",
        "提高可引用信息密度与可验证性",
        `平均每个引用有效 Run 仅 ${metrics.citationDensity.toFixed(2)} 条可见引用。`,
        "针对会触发联网检索的问题，提供带时间、数据来源、定义边界和明确实体名的内容块；优先观察引用数量与来源多样性是否同步改善。",
        "目标：引用密度提高，同时不牺牲来源多样性",
      ),
    );
  }

  if (!items.length) {
    items.push(
      priority(
        "P2",
        "进入稳定扩样与对照实验阶段",
        "当前数据质量、可见度与来源结构未出现明显短板。",
        "保持固定 Prompt 池与种子，做时间序列重复；每次只改变一个内容变量，观察提及率、引用率和来源结构是否稳定变化。",
        "目标：建立跨批次趋势与显著性判断，而不是只看单批次快照",
      ),
    );
  }

  return items.slice(0, 6);
}

export function evaluateBatchDetail(detail) {
  const report = detail?.report ?? {};
  const runs = report.runs ?? {};
  const prompts = report.prompts ?? {};
  const citations = report.citations ?? {};
  const tracked = report.tracked ?? {};

  const assignments = toNumber(runs.assignmentsRun);
  const valid = toNumber(runs.valid);
  const failed = toNumber(runs.failed);
  const partial = toNumber(runs.partial);
  const validRate = assignments > 0 ? valid / assignments : 0;
  const failureRate = assignments > 0 ? failed / assignments : 0;
  const partialRate = assignments > 0 ? partial / assignments : 0;
  const runMentionRate = optionalRate(runs.mentionRate, runs.mentioned, valid);
  const promptCoverage = optionalRate(prompts.mentionCoverage, prompts.mentioned, prompts.total);
  const trackedConfigured = toNumber(tracked.total) > 0;
  const trackedRate = trackedConfigured
    ? optionalRate(tracked.citationRate, tracked.cited, tracked.total)
    : null;

  const citationValidRunsRaw = citations.validRuns == null || citations.validRuns === ""
    ? null
    : Number(citations.validRuns);
  const citationValidRuns = Number.isFinite(citationValidRunsRaw)
    ? Math.max(0, citationValidRunsRaw)
    : null;
  const explicitCitationCoverage = citations.coverage == null || citations.coverage === ""
    ? null
    : Number(citations.coverage);
  const citationEvidenceRate = Number.isFinite(explicitCitationCoverage)
    ? clamp(explicitCitationCoverage)
    : citationValidRuns != null && valid > 0
      ? clamp(citationValidRuns / valid)
      : null;
  const citationDensityDenominator = citationValidRuns ?? valid;
  const citationDensity = citationDensityDenominator > 0
    ? toNumber(citations.total) / citationDensityDenominator
    : null;

  const completeness = citationCompleteness(detail);
  const completenessForScore = completeness.rate == null ? 1 : completeness.rate;
  // Historical exports did not carry citation evidence coverage. Preserve their previous
  // score exactly rather than interpreting a missing field as 0%. New reports add coverage
  // as an independent quality dimension so collection gaps cannot masquerade as business loss.
  const dataQualityScore = citationEvidenceRate == null
    ? score100(
      0.6 * validRate + 0.25 * completenessForScore + 0.15 * clamp(1 - failureRate),
    )
    : score100(
      0.45 * validRate +
      0.2 * completenessForScore +
      0.15 * clamp(1 - failureRate) +
      0.2 * citationEvidenceRate,
    );

  const visibilityParts = [];
  if (promptCoverage != null) visibilityParts.push({ value: promptCoverage, weight: 0.55 });
  if (runMentionRate != null) visibilityParts.push({ value: runMentionRate, weight: 0.35 });
  if (trackedConfigured && trackedRate != null) visibilityParts.push({ value: trackedRate, weight: 0.1 });
  const weightSum = visibilityParts.reduce((sum, item) => sum + item.weight, 0);
  const visibilityIndex = score100(
    weightSum
      ? visibilityParts.reduce((sum, item) => sum + item.value * item.weight, 0) / weightSum
      : 0,
  );

  const source = sourceMetrics(detail);
  const category = categoryMetrics(detail);
  const account = accountMetrics(detail);
  const factorEvidence = factorEvidenceMetrics(detail);
  const sampleConfidence =
    valid >= 100 ? "高" : valid >= 50 ? "中高" : valid >= 25 ? "中" : valid >= 10 ? "偏低" : "低";

  const ownedScore = trackedConfigured && trackedRate != null ? score100(trackedRate) : null;
  const geoParts = [
    { value: dataQualityScore, weight: 0.25 },
    { value: visibilityIndex, weight: 0.4 },
    { value: source.diversityScore, weight: 0.2 },
  ];
  if (ownedScore != null) geoParts.push({ value: ownedScore, weight: 0.15 });
  const geoWeight = geoParts.reduce((sum, item) => sum + item.weight, 0);
  const readinessIndex = Math.round(
    geoParts.reduce((sum, item) => sum + item.value * item.weight, 0) / geoWeight,
  );

  const metrics = {
    assignments,
    valid,
    failed,
    partial,
    validRate,
    failureRate,
    partialRate,
    runMentionRate,
    promptCoverage,
    trackedConfigured,
    trackedRate,
    citationValidRuns,
    citationEvidenceRate,
    citationDensity,
    citationCompleteness: completeness,
    dataQualityScore,
    dataQualityGrade: grade(dataQualityScore),
    dataQualityTone: tone(dataQualityScore),
    visibilityIndex,
    visibilityGrade: grade(visibilityIndex),
    source,
    category,
    account,
    factorEvidence,
    sampleConfidence,
    readinessIndex,
    readinessGrade: grade(readinessIndex),
  };

  const caveats = [
    "OneGl 评分是基于当前观测数据的内部评估框架，不是豆包官方评分或隐藏排序权重。",
    "提及、引用和来源分布是相关性证据，不能单独证明某个页面特征导致了引用结果。",
    valid < 50
      ? `当前仅 ${valid} 个有效 Run，样本量较小，适合发现方向，不适合宣称稳定规律。`
      : "当前样本量可用于稳定性观察，但跨时间、跨账号重复仍然重要。",
    "页面/产品行为可能变化，报告应同时保留批次种子、时间、账号和失败样本口径。",
  ];
  if (citationEvidenceRate != null && citationEvidenceRate < 1) {
    caveats.push(
      `当前引用证据覆盖 ${(citationEvidenceRate * 100).toFixed(1)}%（${citationValidRuns}/${valid}）；引用密度和来源分布只代表引用有效 Run，不代表全部 answer-valid Run。`,
    );
  }
  if (factorEvidence.available) {
    caveats.push(
      "候选页面因子使用 OneGl 后续公开 HTTP 快照；FDR q-value 只降低多重比较中的偶然发现风险，不能替代跨批次复现、多变量控制和样本外验证。",
    );
  }

  return {
    version: 3,
    metrics,
    recommendations: buildRecommendations(metrics),
    caveats,
  };
}

export function evaluationBrowserBundle() {
  return [
    toNumber,
    ratio,
    optionalRate,
    clamp,
    score100,
    average,
    grade,
    tone,
    normalizeSourceDistribution,
    sourceMetrics,
    citationCompleteness,
    categoryMetrics,
    accountMetrics,
    factorEvidenceMetrics,
    priority,
    signalDescription,
    buildRecommendations,
    evaluateBatchDetail,
  ]
    .map((fn) => fn.toString())
    .join("\n");
}