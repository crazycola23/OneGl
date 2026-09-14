import "dotenv/config";
import { analyzeCitationFactors, rankFactorSignals, wilsonInterval } from "../src/analysis/citation-factors.js";
import { createPool } from "../src/db/pool.js";

const pool = createPool();

const FACTOR_LABELS = {
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

function pct(value) {
  if (value == null || !Number.isFinite(Number(value))) return "n/a";
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function signedPct(value) {
  if (value == null || !Number.isFinite(Number(value))) return "n/a";
  const number = Number(value) * 100;
  return `${number >= 0 ? "+" : ""}${number.toFixed(1)}%`;
}

function parseArgs(argv) {
  const args = { batchId: null, minN: 10, signalMinN: 20, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--batch") args.batchId = Number(argv[++index]);
    else if (value === "--min-n") args.minN = Number(argv[++index]);
    else if (value === "--signal-min-n") args.signalMinN = Number(argv[++index]);
    else if (value === "--json") args.json = true;
    else if (!value.startsWith("--") && args.batchId == null) args.batchId = Number(value);
    else throw new Error(`Unknown argument: ${value}`);
  }

  if (!Number.isInteger(args.batchId) || args.batchId <= 0) {
    throw new Error("Usage: npm run report:factors -- --batch <positive batch id> [--min-n 10] [--signal-min-n 20] [--json]");
  }
  if (!Number.isInteger(args.minN) || args.minN <= 0) throw new Error("--min-n must be a positive integer");
  if (!Number.isInteger(args.signalMinN) || args.signalMinN <= 0) throw new Error("--signal-min-n must be a positive integer");
  return args;
}

async function loadCandidates(batchId) {
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
    const group = groups.get(domain) ?? { domain, candidates: 0, cited: 0, articles: new Set(), runs: new Set() };
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
      return { domain: group.domain, candidates: group.candidates, cited: group.cited, rate, ciLow, ciHigh, articles: group.articles.size, runs: group.runs.size };
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

function buildReport(rows, options) {
  const analysis = analyzeCitationFactors(
    rows.map((row) => ({ ...row, sourcePosition: row.source_position, sourceName: row.source_name, searchQueryCount: row.search_query_count, articleRetrievals: row.article_retrievals })),
    { minN: options.minN },
  );
  const runs = new Set(rows.map((row) => String(row.run_id))).size;
  return {
    batchId: options.batchId,
    cohort: {
      definition: "success + confirmed fresh conversation + network evidence found",
      runs,
      candidates: analysis.summary.candidates,
      cited: analysis.summary.cited,
      baselineRate: analysis.summary.baselineRate,
    },
    pageEvidence: pageEvidenceStats(rows),
    factors: analysis.factors,
    strongestSignals: rankFactorSignals(analysis, { minN: options.signalMinN }).slice(0, 20),
    domains: domainStats(rows).slice(0, 30),
    semantics: {
      outcome: "candidate canonical URL exactly matched a DOM-visible citation in the same run",
      interpretation: "descriptive association, not causal effect and not Doubao internal score",
      pageEvidence: "derived by OneGl from a later batch-scoped public HTTP snapshot; it does not prove Doubao saw the same page representation",
      partialRunsExcluded: true,
    },
  };
}

function printReport(report) {
  const { cohort } = report;
  console.log(`\n=== Citation Factor Analysis / Batch ${report.batchId} ===`);
  console.table([{ 干净运行: cohort.runs, 候选来源: cohort.candidates, 最终引用命中: cohort.cited, 基线转化率: pct(cohort.baselineRate) }]);

  if (!cohort.candidates) {
    console.log("没有可分析的候选来源。请先启用 Network evidence 并采集成功批次。");
    return;
  }

  console.log("\n口径：只分析 success + 已确认新会话 + network evidence=found 的运行；partial/failed 不进入因子分析。");
  console.log(`页面证据：${report.pageEvidence.successfulArticles}/${report.pageEvidence.totalArticles} 篇唯一候选文章抓取成功（${pct(report.pageEvidence.successRate)}）。页面特征只对抓取成功样本有效。\n`);

  const grouped = new Map();
  for (const row of report.factors) {
    const items = grouped.get(row.factor) ?? [];
    items.push(row);
    grouped.set(row.factor, items);
  }

  for (const [factor, rows] of grouped) {
    console.log(`=== ${FACTOR_LABELS[factor] ?? factor} ===`);
    console.table(rows.map((row) => ({ 分组: row.bucket, 样本: row.candidates, 命中: row.cited, 引用率: pct(row.rate), 相对基线: signedPct(row.uplift), "95%区间": `${pct(row.ciLow)} ~ ${pct(row.ciHigh)}` })));
  }

  if (report.strongestSignals.length) {
    console.log("=== 关联幅度最大的分组（达到最低样本门槛；missing 不参与探行） ===");
    console.table(report.strongestSignals.map((row) => ({ 因子: FACTOR_LABELS[row.factor] ?? row.factor, 分组: row.bucket, 样本: row.candidates, 引用率: pct(row.rate), 相对基线: signedPct(row.uplift), "95%区间": `${pct(row.ciLow)} ~ ${pct(row.ciHigh)}` })));
  }

  if (report.domains.length) {
    console.log("=== 候选量最高的域名（描述性，不控制混杂因素） ===");
    console.table(report.domains.map((row) => ({ 域名: row.domain, 候选: row.candidates, 最终引用: row.cited, 引用率: pct(row.rate), "95%区间": `${pct(row.ciLow)} ~ ${pct(row.ciHigh)}`, 文章数: row.articles, 运行数: row.runs })));
  }

  console.log("\n注意：uplift 是观察到的相关性，不等于因果影响，也不是豆包内部权重。页面特征来自 OneGl 自己的公开 HTTP 抓取快照；动态渲染、地区差异、登录墙和抓取时间差都会造成观测偏差。必须跨批次复现后才能形成优化建议。");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rows = await loadCandidates(options.batchId);
  const report = buildReport(rows, options);
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printReport(report);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => undefined));
