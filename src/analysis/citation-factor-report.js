import {
  analyzeCitationFactors,
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
    .map((value, index) => ({ index, value: Number(value) }))
    .filter((row) => Number.isFinite(row.value) && row.value >= 0 && row.value <= 1)
    .sort((a, b) => a.value - b.value);
  const out = Array(values.length).fill(null);
  let running = 1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const adjusted = Math.min(1, (rows[i].value * rows.length) / (i + 1));
    running = Math.min(running, adjusted);
    out[rows[i].index] = running;
  }
  return out;
}

function evidenceLevel(row) {
  if (row?.qValue != null && row.qValue <= 0.05 && row.candidates >= 50) return "较强";
  if (row?.qValue != null && row.qValue <= 0.1 && row.candidates >= 30) return "中等";
  if (row?.candidates >= 20) return "探索性";
  return "样本不足";
}

export function annotateMultipleTesting(analysis) {
  const rows = Array.isArray(analysis?.factors) ? analysis.factors.map((row) => ({ ...row })) : [];
  const total = Number(analysis?.summary?.candidates ?? 0);
  const cited = Number(analysis?.summary?.cited ?? 0);

  for (const row of rows) {
    const restN = total - Number(row.candidates ?? 0);
    const restCited = cited - Number(row.cited ?? 0);
    row.pValue = row.bucket === "missing"
      ? null
      : twoProportionPValue(row.cited, row.candidates, restCited, restN);
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

export function buildCitationFactorReportFromRows(rows, {
  batchId = null,
  minN = 10,
  signalMinN = 20,
} = {}) {
  const normalized = rows.map((row) => ({
    ...row,
    sourcePosition: row.sourcePosition ?? row.source_position,
    sourceName: row.sourceName ?? row.source_name,
    searchQueryCount: row.searchQueryCount ?? row.search_query_count,
    articleRetrievals: row.articleRetrievals ?? row.article_retrievals,
  }));
  const raw = analyzeCitationFactors(normalized, { minN });
  const analysis = annotateMultipleTesting(raw);
  const runs = new Set(rows.map((row) => String(row.run_id ?? row.runId ?? ""))).size;
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
    pageEvidence: pageEvidenceStats(rows),
    factors: analysis.factors,
    strongestSignals,
    domains: domainStats(rows).slice(0, 30),
    semantics: {
      outcome: "candidate canonical URL exactly matched a DOM-visible citation in the same run",
      interpretation: "descriptive association, not causal effect and not Doubao internal score",
      pageEvidence: "derived by OneGl from a later batch-scoped public HTTP snapshot; it does not prove Doubao saw the same page representation",
      multipleTesting: "two-proportion exploratory p-values with Benjamini-Hochberg FDR correction across reported non-missing buckets",
      partialRunsExcluded: true,
    },
  };
}

export async function loadCitationFactorReport(pool, batchId, options = {}) {
  const rows = await loadCitationFactorCandidates(pool, batchId);
  return buildCitationFactorReportFromRows(rows, { batchId, ...options });
}
