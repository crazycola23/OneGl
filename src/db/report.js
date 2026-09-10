import { loadBatch } from "../sampling/batch.js";

/**
 * Sampling batch report.
 *
 * Run-level and prompt-level mention rates are reported as separate numbers on purpose:
 * if one prompt is repeated many times, a run-level rate drifts towards that prompt and
 * stops describing the keyword pool. They answer different questions and are never
 * merged into a single score.
 */

// A run is a valid observation when the answer was captured from a confirmed fresh
// conversation. `partial` runs qualify: their answer is complete and real, only the
// citation-count reconciliation failed, which is a citation-quality signal rather than
// an answer-invalidating one. Failed runs never qualify, and neither does a run whose
// conversation reset could not be confirmed, because its answer may have been shaped
// by leftover history.
const VALID_RUN =
  "r.status IN ('success', 'partial') AND r.conversation_reset_confirmed IS TRUE";

function pct(numerator, denominator) {
  if (!denominator) return "n/a";
  return `${((Number(numerator) / Number(denominator)) * 100).toFixed(1)}%`;
}

const num = (value) => Number(value ?? 0);

export async function buildBatchReport(pool, batchId) {
  const batch = await loadBatch(pool, batchId);

  const [runs] = (
    await pool.query(
      `SELECT
         count(*)                                        AS assignments_run,
         count(*) FILTER (WHERE ${VALID_RUN})            AS valid_runs,
         count(*) FILTER (WHERE r.status = 'partial')    AS partial_runs,
         count(*) FILTER (WHERE r.status = 'failed')     AS failed_runs,
         count(*) FILTER (
           WHERE r.status IN ('success', 'partial')
             AND r.conversation_reset_confirmed IS NOT TRUE
         )                                              AS unconfirmed_reset,
         count(*) FILTER (WHERE ${VALID_RUN} AND r.brand_mentioned) AS runs_mentioned
       FROM runs r
      WHERE r.sampling_batch_id = $1`,
      [batchId],
    )
  ).rows;

  const [prompts] = (
    await pool.query(
      `SELECT count(DISTINCT r.prompt_id) AS prompts_total,
              count(DISTINCT r.prompt_id) FILTER (WHERE r.brand_mentioned) AS prompts_mentioned
         FROM runs r
        WHERE r.sampling_batch_id = $1 AND ${VALID_RUN}`,
      [batchId],
    )
  ).rows;

  const [citations] = (
    await pool.query(
      `SELECT count(*) AS citations,
              count(DISTINCT c.article_id) AS articles,
              count(DISTINCT a.normalized_domain) AS domains
         FROM citations c
         JOIN articles a ON a.id = c.article_id
         JOIN runs r ON r.id = c.run_id
        WHERE r.sampling_batch_id = $1`,
      [batchId],
    )
  ).rows;

  const [tracked] = (
    await pool.query(
      `WITH batch_citations AS (
         SELECT c.tracked_article_id
           FROM citations c
           JOIN runs r ON r.id = c.run_id
          WHERE r.sampling_batch_id = $1 AND c.tracked_article_id IS NOT NULL
       )
       SELECT (SELECT count(*) FROM tracked_articles WHERE project_id = $2 AND enabled) AS tracked_total,
              (SELECT count(DISTINCT tracked_article_id) FROM batch_citations) AS tracked_cited`,
      [batchId, batch.project_id],
    )
  ).rows;

  const trackedArticles = (
    await pool.query(
      `WITH batch_citations AS (
         SELECT c.id, c.tracked_article_id, c.run_id, r.prompt_id, r.account_key, c.created_at
           FROM citations c
           JOIN runs r ON r.id = c.run_id
          WHERE r.sampling_batch_id = $1
       )
       SELECT t.canonical_url, t.title, t.normalized_domain AS domain,
              count(bc.id)                  AS citations,
              count(DISTINCT bc.run_id)     AS runs,
              count(DISTINCT bc.prompt_id)  AS prompts,
              count(DISTINCT bc.account_key) AS accounts,
              min(bc.created_at)            AS first_seen_at,
              max(bc.created_at)            AS last_seen_at
         FROM tracked_articles t
         LEFT JOIN batch_citations bc ON bc.tracked_article_id = t.id
        WHERE t.project_id = $2 AND t.enabled = true
        GROUP BY t.id
        ORDER BY citations DESC, t.canonical_url`,
      [batchId, batch.project_id],
    )
  ).rows;

  const topArticles = (
    await pool.query(
      `SELECT a.canonical_url, a.title, a.normalized_domain AS domain,
              count(*) AS citations, count(DISTINCT c.run_id) AS runs
         FROM citations c
         JOIN articles a ON a.id = c.article_id
         JOIN runs r ON r.id = c.run_id
        WHERE r.sampling_batch_id = $1
        GROUP BY a.id
        ORDER BY citations DESC, a.canonical_url
        LIMIT 10`,
      [batchId],
    )
  ).rows;

  const topDomains = (
    await pool.query(
      `SELECT a.normalized_domain AS domain,
              count(*) AS citations,
              count(DISTINCT a.id) AS articles,
              count(DISTINCT c.run_id) AS runs
         FROM citations c
         JOIN articles a ON a.id = c.article_id
         JOIN runs r ON r.id = c.run_id
        WHERE r.sampling_batch_id = $1
        GROUP BY 1
        ORDER BY citations DESC, domain
        LIMIT 10`,
      [batchId],
    )
  ).rows;

  // DISTINCT ON keeps the join 1:1 even if a prompt was repeated on the same account.
  const byCategory = (
    await pool.query(
      `WITH assignment AS (
         SELECT DISTINCT ON (prompt_id, account_key) prompt_id, account_key, category
           FROM sampling_batch_prompts
          WHERE batch_id = $1
          ORDER BY prompt_id, account_key, selection_index
       )
       SELECT COALESCE(a.category, 'uncategorized') AS category,
              count(*) AS valid_runs,
              count(*) FILTER (WHERE r.brand_mentioned) AS mentioned
         FROM runs r
         JOIN assignment a
           ON a.prompt_id = r.prompt_id
          AND a.account_key IS NOT DISTINCT FROM r.account_key
        WHERE r.sampling_batch_id = $1 AND ${VALID_RUN}
        GROUP BY 1
        ORDER BY valid_runs DESC, category`,
      [batchId],
    )
  ).rows;

  const byAccount = (
    await pool.query(
      `SELECT COALESCE(r.account_key, '(unassigned)') AS account,
              count(*) AS valid_runs,
              count(*) FILTER (WHERE r.brand_mentioned) AS mentioned,
              count(DISTINCT r.prompt_id) AS prompts,
              sum(r.captured_citation_count) AS citations
         FROM runs r
        WHERE r.sampling_batch_id = $1 AND ${VALID_RUN}
        GROUP BY 1
        ORDER BY valid_runs DESC, account`,
      [batchId],
    )
  ).rows;

  const failures = (
    await pool.query(
      `SELECT COALESCE(r.error_code, '(none)') AS error_code, count(*) AS runs
         FROM runs r
        WHERE r.sampling_batch_id = $1 AND r.status = 'failed'
        GROUP BY 1
        ORDER BY runs DESC`,
      [batchId],
    )
  ).rows;

  const validRuns = num(runs.valid_runs);

  return {
    batch,
    runs: {
      assignmentsRun: num(runs.assignments_run),
      valid: validRuns,
      partial: num(runs.partial_runs),
      failed: num(runs.failed_runs),
      unconfirmedReset: num(runs.unconfirmed_reset),
      mentioned: num(runs.runs_mentioned),
      mentionRate: validRuns ? num(runs.runs_mentioned) / validRuns : null,
    },
    prompts: {
      total: num(prompts.prompts_total),
      mentioned: num(prompts.prompts_mentioned),
      mentionCoverage: num(prompts.prompts_total)
        ? num(prompts.prompts_mentioned) / num(prompts.prompts_total)
        : null,
    },
    citations: {
      total: num(citations.citations),
      articles: num(citations.articles),
      domains: num(citations.domains),
    },
    tracked: {
      total: num(tracked.tracked_total),
      cited: num(tracked.tracked_cited),
      citationRate: num(tracked.tracked_total)
        ? num(tracked.tracked_cited) / num(tracked.tracked_total)
        : null,
      articles: trackedArticles,
    },
    topArticles,
    topDomains,
    byCategory: byCategory.map((row) => ({
      category: row.category,
      validRuns: num(row.valid_runs),
      mentioned: num(row.mentioned),
      mentionRate: num(row.valid_runs) ? num(row.mentioned) / num(row.valid_runs) : null,
    })),
    byAccount: byAccount.map((row) => ({
      account: row.account,
      validRuns: num(row.valid_runs),
      mentioned: num(row.mentioned),
      mentionRate: num(row.valid_runs) ? num(row.mentioned) / num(row.valid_runs) : null,
      prompts: num(row.prompts),
      citations: num(row.citations),
    })),
    failures,
  };
}

export function printBatchReport(report, { log = console.log } = {}) {
  const { batch, runs, prompts, citations, tracked } = report;

  log("");
  log(`抽样批次 #${batch.id}  ${batch.name}`);
  log(`  项目        : ${batch.project_name}   目标品牌: ${batch.target_brand ?? "未配置"}`);
  log(`  服务方      : ${batch.provider}`);
  log(`  状态        : ${batch.status}`);
  log(
    `  抽样        : 方式=${batch.sampling_method === "stratified" ? "分层" : "纯随机"} ` +
      `种子=${batch.sampling_seed} 池=${batch.pool_size} 抽样=${batch.sample_size} 重复=${batch.repeats}`,
  );
  log(`  账号        : ${(batch.account_keys ?? []).join(", ") || "未配置"}`);
  log(`  开始 / 结束 : ${batch.started_at ?? "-"} / ${batch.finished_at ?? "-"}`);

  log("");
  log("运行统计");
  log(`  分配运行数              : ${runs.assignmentsRun}`);
  log(`  有效运行（已确认新会话）: ${runs.valid}`);
  log(`  部分成功 / 失败         : ${runs.partial} / ${runs.failed}`);
  log(`  新会话未确认            : ${runs.unconfirmedReset}`);
  log(`  RUN 级品牌提及率        : ${pct(runs.mentioned, runs.valid)}  (${runs.mentioned}/${runs.valid})`);
  log(
    `  PROMPT 级提及覆盖       : ${pct(prompts.mentioned, prompts.total)}  ` +
      `(${prompts.mentioned}/${prompts.total} 个去重问题)`,
  );

  log("");
  log("引用统计");
  log(
    `  可见引用 / 唯一文章 / 唯一域名 : ${citations.total} / ${citations.articles} / ${citations.domains}`,
  );

  log("");
  log(
    `目标文章：${tracked.cited}/${tracked.total} 至少被引用一次（引用率 ${pct(tracked.cited, tracked.total)}）`,
  );
  if (tracked.articles.length) {
    log("");
    console.table(
      tracked.articles.slice(0, 20).map((row) => ({
        域名: row.domain,
        被引用次数: Number(row.citations),
        涉及问题数: Number(row.prompts),
        账号数: Number(row.accounts),
        首次出现: row.first_seen_at,
        最近出现: row.last_seen_at,
        链接: String(row.canonical_url).slice(0, 70),
      })),
    );
  }

  if (report.byCategory.length) {
    log("按问题分类拆分");
    console.table(
      report.byCategory.map((row) => ({
        分类: row.category,
        有效运行: row.validRuns,
        提及: row.mentioned,
        提及率: pct(row.mentioned, row.validRuns),
      })),
    );
  }

  if (report.byAccount.length) {
    log("按账号拆分");
    console.table(
      report.byAccount.map((row) => ({
        账号: row.account,
        有效运行: row.validRuns,
        提及: row.mentioned,
        提及率: pct(row.mentioned, row.validRuns),
        去重问题数: row.prompts,
        引用数: Number(row.citations ?? 0),
      })),
    );
  }

  if (report.topDomains.length) {
    log("被引用最多的域名");
    console.table(
      report.topDomains.map((row) => ({
        域名: row.domain,
        引用数: Number(row.citations),
        文章数: Number(row.articles),
        占比: pct(row.citations, citations.total),
      })),
    );
  }

  if (report.topArticles.length) {
    log("被引用最多的文章");
    console.table(
      report.topArticles.map((row) => ({
        引用数: Number(row.citations),
        域名: row.domain,
        标题: String(row.title ?? "").slice(0, 44),
        链接: String(row.canonical_url).slice(0, 60),
      })),
    );
  }

  if (report.failures.length) {
    log("失败原因");
    console.table(
      report.failures.map((row) => ({ 错误: row.error_code, 运行数: Number(row.runs) })),
    );
  }
  log("");
}
