import {
  analyzeCitationFactors,
  analyzeCitationFactorsStratified,
  candidateFeatures,
  rankFactorSignals,
  wilsonInterval,
} from "./citation-factors.js";

export const FACTOR_LABELS = {
  candidate_position: "候选位次",
  title_prompt_overlap: "标题↔原问题词面重合",
  title_query_overlap: "标题↔搜索词词面重合",
  summary_prompt_overlap: "摘要↔原问题词面重合",
  title_present: "有标题",
  summary_present: "有摘要",
  source_name_present: "有来源名",
  search_query_count: "本轮搜索词数量",
  article_retrieval_frequency: "文章在批次内候选频次",
  page_text_length: "页面可见文本长度",
  page_h2_count: "页面 H2 数量",
  page_table_present: "页面包含表格",
  page_list_present: "页面包含列表",
  page_faq_heading_signal: "页面 FAQ/问答标题信号",
  page_article_schema: "Article 类 JSON-LD",
  page_faq_schema: "FAQPage JSON-LD",
  page_author_signal: "作者元数据/结构化信号",
  page_modified_date_signal: "更新时间信号",
  page_noindex_signal: "robots noindex 信号",
  page_numeric_density: "数字密度（每千字符数字 token）",
  page_external_links: "外部链接数量",
};

function erf(value) {
  // Abramowitz & Stegun 7.1.26. Accurate enough for descriptive two-proportion tests.
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}

function normalCdf(value) {
  return 0.5 * (1 + erf(value / Math.SQRT2));
}

export function twoProportionPValue(successA, totalA, successB, totalB) {
  const x1 = Number(successA);
  const n1 = Number(totalA);
  const x2 = Number(successB);
  const n2 = Number(totalB);
  if (![x1, n1, x2, n2].every(Number.isFinite) || n1 <= 0 || n2 <= 0) return null;
  const pooled = (x1 + x2) / (n1 + n2);
  const variance = pooled * (1 - pooled) * (1 / n1 + 1 / n2);
  if (!(variance > 0)) return 1;
  const z = (x1 / n1 - x2 / n2) / Math.sqrt(variance);
  return Math.max(0, Math.min(1, 2 * (1 - normalCdf(Math.abs(z)))));
}

export function benjaminiHochberg(values) {
  const rows = values
    .map((value, index) => ({ index, raw: value }))
    .filter((row) => row.raw != null && row.raw !== "")
    .map((row) => ({ ...row, value: Number(row.raw) }))
    .filter((row) => Number.isFinite(row.value) && row.value >= 0 && row.value <= 1)
    .sort((a, b) => a.value - b.value);
  const out = Array(values.length).fill(null);
  let running = 1;
  const tested = rows.length;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const adjusted = Math.min(1, (rows[i].value * tested) / (i + 1));
    running = Math.min(running, adjusted);
    out[rows[i].index] = running;
  }
  return out;
}

function evidenceLevel(row) {
  // Evidence level requires three things at once: the effect survives the within-domain
  // comparison, it points the same way in most domains that could test it, and it is not
  // contradicted by domains pointing the other way. A bucket whose pooled uplift vanishes
  // once the domain is held constant is a site-composition artefact, not evidence.
  const consistent = row?.directionConsistent === true;
  const opposite = Number(row?.domainsWithNegativeDifference ?? 0);
  const agreeing = Number(row?.domainsWithPositiveDifference ?? 0);
  const pairedDomains = Number(row?.pairedDomains ?? 0);

  if (row?.significanceBasis === "pooled_naive") {
    // No domain could be paired at all - every domain contributed only one arm. The
    // pooled difference is then indistinguishable from "different sites look different",
    // so it can never rise above exploratory.
    return row?.candidates >= 30 ? "探索性（无域内对照，仅有合并口径）" : "样本不足";
  }

  // Every domain moved the same way: the signed-rank statistic has no variance left, so
  // the decision is carried by how much agreement there is - and it has to be a lot.
  if (row?.withinDomainNote === "degenerate-all-tied") {
    if (consistent && pairedDomains >= 5 && agreeing >= 5) return "中等（域内方向完全一致）";
    return row?.candidates >= 20 ? "探索性" : "样本不足";
  }

  // Domains disagreeing in direction cap the claim regardless of the p-value.
  if (pairedDomains >= 3 && opposite >= Math.ceil(pairedDomains * 0.25)) {
    return row?.candidates >= 20 ? "探索性（域内方向不一致）" : "样本不足";
  }

  if (consistent && row?.qValue != null && row.qValue <= 0.05 && row.candidates >= 50 && pairedDomains >= 5) return "较强";
  if (consistent && row?.qValue != null && row.qValue <= 0.1 && row.candidates >= 30 && pairedDomains >= 3) return "中等";
  if (row?.candidates >= 20) return "探索性";
  return "样本不足";
}

export function annotateMultipleTesting(analysis, { stratified = null } = {}) {
  const rows = Array.isArray(analysis?.factors) ? analysis.factors.map((row) => ({ ...row })) : [];
  const total = Number(analysis?.summary?.candidates ?? 0);
  const cited = Number(analysis?.summary?.cited ?? 0);
  const byKey = new Map(
    (Array.isArray(stratified?.factors) ? stratified.factors : []).map((row) => [`${row.factor}\u0000${row.bucket}`, row]),
  );

  for (const row of rows) {
    const restN = total - Number(row.candidates ?? 0);
    const restCited = cited - Number(row.cited ?? 0);
    // Kept for transparency, but it is NOT the p-value behind the FDR column any more:
    // it assumes every candidate row is an independent observation, which they are not.
    row.pValueNaive = row.bucket === "missing"
      ? null
      : twoProportionPValue(row.cited, row.candidates, restCited, restN);

    const stratum = byKey.get(`${row.factor}\u0000${row.bucket}`) ?? null;
    row.domains = stratum?.domains ?? null;
    row.pairedDomains = stratum?.pairedDomains ?? 0;
    row.pooledUplift = row.uplift;
    row.withinDomainDifference = stratum?.withinDomainDifference ?? null;
    row.withinDomainCiLow = stratum?.withinDomainCiLow ?? null;
    row.withinDomainCiHigh = stratum?.withinDomainCiHigh ?? null;
    row.domainsWithPositiveDifference = stratum?.domainsWithPositiveDifference ?? 0;
    row.domainsWithNegativeDifference = stratum?.domainsWithNegativeDifference ?? 0;
    row.directionConsistent = Boolean(stratum?.directionConsistent);
    row.withinDomainNote = stratum?.withinDomainNote ?? null;
    // Primary p-value: paired within-domain comparison. Falls back to the naive test only
    // when there are too few domains for a paired comparison, and that fallback is
    // flagged in `significanceBasis` so no reader mistakes it for the stronger test.
    row.pValue = row.bucket === "missing" ? null : (stratum?.withinDomainPValue ?? row.pValueNaive);
    row.significanceBasis = row.bucket === "missing"
      ? null
      : (stratum?.withinDomainPValue != null ? "paired_within_domain" : "pooled_naive");

    // No extra "the pooled and within-domain numbers disagree" flag is computed here,
    // because it would be unreachable. With complete pairs - every domain contributing to
    // both arms - the pooled difference is algebraically proportional to the within-domain
    // difference, so the two can only differ in magnitude. A bucket that no domain can
    // pair has no within-domain estimate at all, and is capped at exploratory by
    // `significanceBasis === "pooled_naive"` instead. The composition risk is therefore
    // handled by the evidence ladder below rather than by a flag that never fires.
  }

  const eligible = rows.map((row) => row.pValue);
  const qValues = benjaminiHochberg(eligible);
  rows.forEach((row, index) => {
    row.qValue = qValues[index];
    row.evidenceLevel = evidenceLevel(row);
    row.factorLabel = FACTOR_LABELS[row.factor] ?? row.factor;
  });

  return { ...analysis, factors: rows };
}

export async function loadCitationFactorCandidates(pool, batchId) {
  return (
    await pool.query(
      `WITH candidates AS (
         SELECT rs.id,
                rs.run_id,
                rs.article_id,
                rs.source_position,
                rs.source_name,
                rs.summary,
                (rs.visible_citation_id IS NOT NULL) AS cited,
                a.title,
                a.normalized_domain AS domain,
                p.prompt,
                r.search_query_count,
                r.started_at,
                apo.fetch_state AS page_evidence_state,
                apo.text_length AS page_text_length,
                apo.numeric_tokens_per_1000_chars AS page_numeric_density,
                apo.h2_count AS page_h2_count,
                apo.table_count AS page_table_count,
                apo.list_count AS page_list_count,
                apo.faq_heading_count AS page_faq_heading_count,
                apo.external_link_count AS page_external_link_count,
                apo.has_article_schema AS page_has_article_schema,
                apo.has_faq_schema AS page_has_faq_schema,
                apo.author_present AS page_author_present,
                apo.modified_at_raw AS page_modified_at_raw,
                apo.robots_noindex AS page_robots_noindex,
                COALESCE(
                  (SELECT array_agg(q.query_text ORDER BY q.query_position)
                     FROM run_search_queries q
                    WHERE q.run_id = r.id),
                  ARRAY[]::text[]
                ) AS queries
           FROM retrieved_sources rs
           JOIN articles a ON a.id = rs.article_id
           JOIN runs r ON r.id = rs.run_id
           JOIN prompts p ON p.id = r.prompt_id
           LEFT JOIN article_page_observations apo
             ON apo.batch_id = r.sampling_batch_id AND apo.article_id = rs.article_id
          WHERE r.sampling_batch_id = $1
            AND r.status = 'success'
            AND r.conversation_reset_confirmed IS TRUE
            AND r.network_evidence_state = 'found'
       )
       SELECT candidates.*,
              count(*) OVER (PARTITION BY article_id) AS article_retrievals
         FROM candidates
        ORDER BY started_at, run_id, source_position`,
      [batchId],
    )
  ).rows;
}

function domainStats(rows) {
  const groups = new Map();
  for (const row of rows) {
    const domain = row.domain || "unknown";
    const group = groups.get(domain) ?? {
      domain,
      candidates: 0,
      cited: 0,
      articles: new Set(),
      runs: new Set(),
    };
    group.candidates += 1;
    if (row.cited) group.cited += 1;
    group.articles.add(String(row.article_id));
    group.runs.add(String(row.run_id));
    groups.set(domain, group);
  }
  return [...groups.values()]
    .map((group) => {
      const rate = group.candidates ? group.cited / group.candidates : null;
      const [ciLow, ciHigh] = wilsonInterval(group.cited, group.candidates);
      return {
        domain: group.domain,
        candidates: group.candidates,
        cited: group.cited,
        rate,
        ciLow,
        ciHigh,
        articles: group.articles.size,
        runs: group.runs.size,
      };
    })
    .sort((a, b) => b.candidates - a.candidates || b.rate - a.rate || a.domain.localeCompare(b.domain));
}

function pageEvidenceStats(rows) {
  const articles = new Map();
  for (const row of rows) {
    const key = String(row.article_id);
    if (!articles.has(key)) articles.set(key, row.page_evidence_state ?? "missing");
  }
  const states = {};
  for (const state of articles.values()) states[state] = (states[state] ?? 0) + 1;
  const totalArticles = articles.size;
  const successfulArticles = states.success ?? 0;
  return {
    totalArticles,
    successfulArticles,
    successRate: totalArticles ? successfulArticles / totalArticles : null,
    candidateRowsWithSuccessfulPageEvidence: rows.filter((row) => row.page_evidence_state === "success").length,
    states,
  };
}

/**
 * Whether this batch is allowed to produce optimisation recommendations at all.
 *
 * The factor table is persuasive by construction - it has uplift, intervals and q-values -
 * so the gate has to sit *before* it, not in a footnote after it. Every reason here is a
 * way the numbers can look meaningful while resting on an unobserved majority.
 */
export function buildEvidenceGate({ cohort, pageEvidence, domains, design, matchCoverage = null }) {
  const blockers = [];
  const warnings = [];

  if (matchCoverage == null) {
    warnings.push({
      code: "MATCH_COVERAGE_UNKNOWN",
      message: "本批次没有提供匹配覆盖率，无法判断候选层是否抓全；转化率应只作观察。",
    });
  } else {
    if (matchCoverage.observedShare != null && matchCoverage.observedShare < 0.6) {
      blockers.push({
        code: "MATCH_COVERAGE_LOW",
        message: `精确+别名命中只覆盖 ${(matchCoverage.observedShare * 100).toFixed(1)}% 的候选，其余未匹配。未匹配既可能是「没被引用」，也可能是网络证据没抓全——在区分清楚之前不支持优化建议。`,
      });
    } else if (matchCoverage.observedShare < 0.8) {
      warnings.push({
        code: "MATCH_COVERAGE_MODERATE",
        message: `匹配覆盖率 ${(matchCoverage.observedShare * 100).toFixed(1)}%，未匹配部分仍需先排除抓取缺失。`,
      });
    }
  }

  if (cohort.candidates < 200) {
    blockers.push({
      code: "COHORT_SMALL",
      message: `候选样本 ${cohort.candidates} 条，低于 200 条的门槛；单因子分桶后每格样本会更小。`,
    });
  }

  if ((design?.domainCount ?? 0) < 20) {
    warnings.push({
      code: "DOMAIN_COUNT_LOW",
      message: `候选只来自 ${design?.domainCount ?? 0} 个域名。域名少时，任何因子差异都很容易只是站点差异。`,
    });
  }

  if (pageEvidence.successRate != null && pageEvidence.successRate < 0.7) {
    blockers.push({
      code: "PAGE_EVIDENCE_LOW",
      message: `页面证据覆盖率 ${(pageEvidence.successRate * 100).toFixed(1)}%，低于 70%；页面类因子的 missing 可能集中在特定域名或内容类型。`,
    });
  }

  const pairedDomains = domains?.reduce((max, row) => Math.max(max, Number(row.pairedDomains ?? 0)), 0) ?? 0;
  if (pairedDomains < 3) {
    warnings.push({
      code: "PAIRED_DOMAINS_LOW",
      message: "同一域名内同时存在该分组与对照的域名数不足 3 个，域内比较的检验力很弱。",
    });
  }

  const status = blockers.length ? "insufficient" : warnings.length ? "directional" : "eligible";
  return {
    status,
    label: status === "eligible" ? "可进入复验" : status === "directional" ? "仅方向性观察" : "证据不足",
    allowOptimizationAdvice: status !== "insufficient",
    blockers,
    warnings,
  };
}

export function buildCitationFactorReportFromRows(rows, {
  batchId = null,
  minN = 10,
  signalMinN = 20,
  matchCoverage = null,
} = {}) {
  const normalized = rows.map((row) => ({
    ...row,
    sourcePosition: row.sourcePosition ?? row.source_position,
    sourceName: row.sourceName ?? row.source_name,
    searchQueryCount: row.searchQueryCount ?? row.search_query_count,
    articleRetrievals: row.articleRetrievals ?? row.article_retrievals,
  }));
  const raw = analyzeCitationFactors(normalized, { minN });
  const stratified = analyzeCitationFactorsStratified(normalized, {
    factorRows: raw.factors,
    rowsForFactor: candidateFeatures,
  });
  const analysis = annotateMultipleTesting(raw, { stratified });
  const runs = new Set(rows.map((row) => String(row.run_id ?? row.runId ?? ""))).size;
  const pageEvidence = pageEvidenceStats(rows);
  const domains = domainStats(rows).slice(0, 30);
  const gate = buildEvidenceGate({
    cohort: {
      runs,
      candidates: analysis.summary.candidates,
      cited: analysis.summary.cited,
      baselineRate: analysis.summary.baselineRate,
    },
    pageEvidence,
    domains: analysis.factors,
    design: stratified.design,
    matchCoverage,
  });
  const strongestSignals = rankFactorSignals(analysis, { minN: signalMinN })
    .map((row) => analysis.factors.find((item) => item.factor === row.factor && item.bucket === row.bucket) ?? row)
    .slice(0, 20);

  return {
    batchId,
    cohort: {
      definition: "success + confirmed fresh conversation + network evidence found",
      runs,
      candidates: analysis.summary.candidates,
      cited: analysis.summary.cited,
      baselineRate: analysis.summary.baselineRate,
    },
    pageEvidence,
    design: stratified.design,
    evidenceGate: gate,
    matchCoverage,
    factors: analysis.factors,
    strongestSignals: gate.allowOptimizationAdvice ? strongestSignals : [],
    suppressedSignals: gate.allowOptimizationAdvice ? [] : strongestSignals.slice(0, 20),
    domains,
    semantics: {
      outcome: "candidate matched a DOM-visible citation in the same run (exact or a labelled alias tier; see retrieval analytics)",
      interpretation: "descriptive association, not causal effect and not Doubao internal score",
      pageEvidence: "derived by OneGl from a later batch-scoped public HTTP snapshot; it does not prove Doubao saw the same page representation",
      multipleTesting: "primary p-values are paired within-domain (Wilcoxon signed-rank over per-domain rate differences) with Benjamini-Hochberg FDR correction; pooled two-proportion p-values are kept only as pValueNaive",
      clustering: "candidate rows are clustered by domain; effective sample size is reported as design.nEff, and the naive count must not be read as independent observations",
      partialRunsExcluded: true,
      gate: "when the evidence gate is insufficient, strongestSignals is empty and the suppressed list is diagnostic only",
    },
  };
}

/**
 * How much of the retrieval layer this batch actually accounted for.
 *
 * `unmatched` is deliberately not called "not cited". An unobserved candidate and an
 * observed-but-not-cited candidate look identical in the ratio and mean very different
 * things, so the number that has to travel next to every conversion rate is the share
 * that matched *nothing*.
 */
export async function loadRetrievalMatchCoverage(pool, batchId) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS candidates,
            count(*) FILTER (WHERE rs.match_method = 'canonical_url_exact')::int AS exact,
            count(*) FILTER (WHERE rs.visible_citation_id IS NOT NULL
                               AND rs.match_method IS DISTINCT FROM 'canonical_url_exact')::int AS alias,
            count(*) FILTER (WHERE rs.visible_citation_id IS NULL)::int AS unmatched,
            count(DISTINCT a.normalized_domain)::int AS domains
       FROM retrieved_sources rs
       JOIN runs r ON r.id = rs.run_id
       JOIN articles a ON a.id = rs.article_id
      WHERE r.sampling_batch_id = $1`,
    [batchId],
  );
  const row = rows[0] ?? {};
  const candidates = Number(row.candidates ?? 0);
  const observed = Number(row.exact ?? 0) + Number(row.alias ?? 0);
  return {
    candidates,
    exact: Number(row.exact ?? 0),
    alias: Number(row.alias ?? 0),
    unmatched: Number(row.unmatched ?? 0),
    domains: Number(row.domains ?? 0),
    observed,
    observedShare: candidates ? observed / candidates : null,
    unmatchedShare: candidates ? Number(row.unmatched ?? 0) / candidates : null,
  };
}

export async function loadCitationFactorReport(pool, batchId, options = {}) {
  const rows = await loadCitationFactorCandidates(pool, batchId);
  const matchCoverage = options.matchCoverage === undefined
    ? await loadRetrievalMatchCoverage(pool, batchId).catch(() => null)
    : options.matchCoverage;
  return buildCitationFactorReportFromRows(rows, { batchId, ...options, matchCoverage });
}
