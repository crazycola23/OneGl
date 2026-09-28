import { buildBrandSourceIntelligence } from "./brand-source-intelligence.js";
import { buildBatchReport } from "./report.js";
import { citationValidRunSql, CITATION_EVIDENCE_STATES } from "./citation-validity.js";

/**
 * Read-only queries that back the dashboard.
 *
 * Answer-valid runs include partial observations because the captured answer remains usable.
 * Citation-valid runs are stricter: citation parsing/reconciliation must have completed and
 * only user-visible DOM citations are eligible for source analytics.
 *
 * 引用有效性判定来自 citation-validity.js —— 判定口径集中在一处，
 * 各平台 citation_state 词表不同时只改那里，不再散落到每个 SQL 片段。
 */
export const VALID_RUN_SQL =
  "r.status IN ('success', 'partial') AND r.conversation_reset_confirmed IS TRUE";
export const CITATION_VALID_RUN_SQL = citationValidRunSql("r");
const VISIBLE_CITATION_SQL = "c.source_type = 'visible' AND c.visible_to_user IS TRUE";

export async function databaseReady(pool) {
  try {
    await pool.query("SELECT 1");
    return { ready: true };
  } catch (error) {
    return { ready: false, message: error.message };
  }
}

export async function countOverview(pool) {
  const [row] = (
    await pool.query(`
      SELECT
        (SELECT count(*) FROM projects)          AS projects,
        (SELECT count(*) FROM prompts)           AS prompts,
        (SELECT count(*) FROM sampling_batches)  AS batches,
        (SELECT count(*) FROM runs)              AS runs,
        (SELECT count(DISTINCT c.article_id)
           FROM citations c
           JOIN runs r ON r.id = c.run_id
          WHERE ${CITATION_VALID_RUN_SQL}
            AND ${VISIBLE_CITATION_SQL})         AS articles,
        (SELECT count(*)
           FROM citations c
           JOIN runs r ON r.id = c.run_id
          WHERE ${CITATION_VALID_RUN_SQL}
            AND ${VISIBLE_CITATION_SQL})         AS citations,
        (SELECT count(*) FROM accounts)          AS accounts
    `)
  ).rows;
  return row;
}

export async function listProjects(pool) {
  return (
    await pool.query(`
      SELECT p.id, p.name, p.description, p.target_brand,
             p.brand_aliases, p.brand_product_aliases, p.brand_exclude_patterns,
             p.created_at, p.updated_at,
             (SELECT count(*) FROM prompts q
               WHERE q.project_id = p.id AND q.deleted_at IS NULL)                     AS pool_size,
             (SELECT count(*) FROM prompts q
               WHERE q.project_id = p.id AND q.enabled AND q.deleted_at IS NULL)       AS pool_enabled,
             (SELECT count(*) FROM sampling_batches b WHERE b.project_id = p.id)       AS batch_count,
             (SELECT count(*) FROM tracked_articles t WHERE t.project_id = p.id AND t.enabled) AS tracked_count,
             (SELECT count(*)
                FROM runs r JOIN prompts q ON q.id = r.prompt_id
               WHERE q.project_id = p.id)                                              AS run_count,
             (SELECT count(*)
                FROM citations c JOIN runs r ON r.id = c.run_id
                JOIN prompts q ON q.id = r.prompt_id
               WHERE q.project_id = p.id
                 AND ${CITATION_VALID_RUN_SQL}
                 AND ${VISIBLE_CITATION_SQL})                                          AS citation_count
        FROM projects p
       ORDER BY p.created_at DESC
    `)
  ).rows;
}

export async function getProject(pool, projectId) {
  const { rows } = await pool.query(
    `SELECT id, name, description, target_brand, brand_aliases, brand_product_aliases,
            brand_exclude_patterns, created_at, updated_at
       FROM projects WHERE id = $1`,
    [projectId],
  );
  return rows[0] ?? null;
}

export async function poolByCategory(pool, projectId) {
  return (
    await pool.query(
      `SELECT COALESCE(category, 'uncategorized') AS category,
              count(*)                            AS prompts,
              count(*) FILTER (WHERE enabled)      AS enabled,
              min(pool_version)                    AS pool_version
         FROM prompts
        WHERE project_id = $1 AND deleted_at IS NULL
        GROUP BY 1
        ORDER BY prompts DESC, category`,
      [projectId],
    )
  ).rows;
}

export async function trackedArticles(pool, projectId) {
  return (
    await pool.query(
      `SELECT t.id, t.canonical_url, t.title, t.domain, t.normalized_domain, t.brand, t.enabled,
              count(c.id)                     AS citations,
              count(DISTINCT c.run_id)        AS runs,
              min(c.created_at)               AS first_seen_at,
              max(c.created_at)               AS last_seen_at
         FROM tracked_articles t
         LEFT JOIN (
           SELECT c.*
             FROM citations c
             JOIN runs r ON r.id = c.run_id
            WHERE ${CITATION_VALID_RUN_SQL}
              AND ${VISIBLE_CITATION_SQL}
         ) c ON c.tracked_article_id = t.id
        WHERE t.project_id = $1
        GROUP BY t.id
        ORDER BY citations DESC, t.canonical_url`,
      [projectId],
    )
  ).rows;
}

export async function listAccounts(pool) {
  return (
    await pool.query(`
      SELECT a.account_key, a.provider, a.enabled, a.status, a.last_health_status,
             a.last_health_checked_at, a.last_run_at, a.runs_today, a.runs_today_date,
             a.consecutive_failures, a.cooldown_until, a.paused_at, a.pause_reason,
             a.last_error_code, a.storage_state_present,
             (SELECT count(*) FROM runs r WHERE r.account_key = a.account_key) AS run_count,
             (SELECT count(*) FROM runs r
               WHERE r.account_key = a.account_key
                 AND r.started_at::date = CURRENT_DATE) AS run_count_today
        FROM accounts a
       ORDER BY a.account_key
    `)
  ).rows;
}

export async function listBatches(pool, { projectId = null, limit = 50 } = {}) {
  return (
    await pool.query(
      `SELECT b.id, b.name, b.provider, b.status, b.pool_version, b.pool_size, b.sample_size,
              b.sampling_method, b.sampling_seed, b.repeats, b.account_keys,
              b.started_at, b.finished_at, b.created_at,
              b.queued_at, b.aborted_at, b.requested_jobs, b.completed_jobs, b.failed_jobs,
              b.skipped_jobs, b.last_heartbeat_at,
              p.name AS project_name, p.target_brand,
              count(r.id)                                                                AS runs_total,
              count(r.id) FILTER (WHERE ${VALID_RUN_SQL})                                AS valid_runs,
              count(r.id) FILTER (WHERE ${CITATION_VALID_RUN_SQL})                       AS citation_valid_runs,
              count(r.id) FILTER (WHERE r.status = 'failed')                             AS failed_runs,
              count(r.id) FILTER (WHERE r.status = 'partial')                            AS partial_runs,
              count(r.id) FILTER (WHERE ${VALID_RUN_SQL} AND r.brand_mentioned)          AS mentioned_runs,
              count(DISTINCT r.prompt_id) FILTER (WHERE ${VALID_RUN_SQL})                AS prompts_total,
              count(DISTINCT r.prompt_id) FILTER (
                WHERE ${VALID_RUN_SQL} AND r.brand_mentioned)                            AS prompts_mentioned,
              COALESCE(sum(r.captured_citation_count) FILTER (WHERE ${CITATION_VALID_RUN_SQL}), 0) AS citations,
              (SELECT count(*) FROM tracked_articles t WHERE t.project_id = b.project_id AND t.enabled) AS tracked_total,
              (SELECT count(DISTINCT c.tracked_article_id)
                 FROM citations c JOIN runs r2 ON r2.id = c.run_id
                WHERE r2.sampling_batch_id = b.id
                  AND r2.status = 'success'
                  AND r2.conversation_reset_confirmed IS TRUE
                  AND r2.citation_state IN (${CITATION_EVIDENCE_STATES.map((s) => `'${s}'`).join(", ")})
                  AND c.source_type = 'visible'
                  AND c.visible_to_user IS TRUE
                  AND c.tracked_article_id IS NOT NULL)                                  AS tracked_cited
         FROM sampling_batches b
         JOIN projects p ON p.id = b.project_id
         LEFT JOIN runs r ON r.sampling_batch_id = b.id
        WHERE ($1::bigint IS NULL OR b.project_id = $1)
        GROUP BY b.id, p.name, p.target_brand
        ORDER BY b.created_at DESC
        LIMIT $2`,
      [projectId, limit],
    )
  ).rows;
}

/** 当前处于执行中（排队或运行）的批次，供总览与批次页展示。 */
export async function listActiveBatches(pool) {
  return (
    await pool.query(
      `SELECT b.id, b.name, b.status, b.project_id,
              b.requested_jobs, b.completed_jobs, b.failed_jobs, b.skipped_jobs,
              b.queued_at, b.started_at, b.last_heartbeat_at, b.account_keys,
              p.name AS project_name, p.target_brand
         FROM sampling_batches b
         JOIN projects p ON p.id = b.project_id
        WHERE b.status IN ('queued', 'running')
        ORDER BY b.started_at DESC NULLS LAST, b.id DESC`,
    )
  ).rows;
}

export async function listRuns(
  pool,
  {
    projectId = null,
    batchId = null,
    status = null,
    accountKey = null,
    errorCode = null,
    provider = null,
    query = null,
    limit = 120,
    offset = 0,
  } = {},
) {
  // 检索走 0032 的 search_text（问题 + 回答合并，中文子串可命中）。
  // 用空字符串而非 null：ILIKE '%%' 会匹配所有非空 search_text，
  // 而 search_text 由触发器保证非空，两者等价，后者能稳定走索引路径。
  const term = query ? String(query) : "";
  return (
    await pool.query(
      `SELECT r.id, r.local_run_id, r.status, r.account_key, r.sampling_batch_id,
             r.started_at, r.finished_at, r.brand_mentioned, r.mention_count,
             r.expected_citation_count, r.captured_citation_count, r.citation_state,
             r.conversation_reset, r.conversation_reset_confirmed, r.error_code,
             r.attempt, length(r.answer) AS answer_chars,
             r.provider, r.answer_truncated, r.answer_completion,
             pr.prompt, pj.name AS project_name, pj.id AS project_id,
             sb.name AS batch_name, sbp.category
         FROM runs r
         JOIN prompts pr ON pr.id = r.prompt_id
         JOIN projects pj ON pj.id = pr.project_id
         LEFT JOIN sampling_batches sb ON sb.id = r.sampling_batch_id
         LEFT JOIN LATERAL (
           SELECT category FROM sampling_batch_prompts sbp
            WHERE sbp.batch_id = r.sampling_batch_id
              AND sbp.prompt_id = r.prompt_id
              AND sbp.account_key IS NOT DISTINCT FROM r.account_key
            ORDER BY sbp.selection_index
            LIMIT 1
         ) sbp ON true
        WHERE ($1::bigint IS NULL OR pj.id = $1)
          AND ($2::bigint IS NULL OR r.sampling_batch_id = $2)
          AND ($3::text IS NULL OR r.status = $3)
          AND ($4::text IS NULL OR r.account_key = $4)
          AND ($5::text IS NULL OR r.error_code = $5)
          AND ($6::text IS NULL OR r.provider = $6)
          AND ($7::text = '' OR r.search_text ILIKE '%' || $7 || '%')
        ORDER BY r.started_at DESC
        LIMIT $8 OFFSET $9`,
      [projectId, batchId, status, accountKey, errorCode, provider, term, limit, offset],
    )
  ).rows;
}

/** 档案页要「命中总数」而不只是当前页行数，所以另配一条计数查询。 */
export async function countRuns(
  pool,
  {
    projectId = null,
    batchId = null,
    status = null,
    accountKey = null,
    errorCode = null,
    provider = null,
    query = null,
  } = {},
) {
  const term = query ? String(query) : "";
  const { rows } = await pool.query(
    `SELECT count(*)::int AS total
       FROM runs r
       JOIN prompts pr ON pr.id = r.prompt_id
       JOIN projects pj ON pj.id = pr.project_id
      WHERE ($1::bigint IS NULL OR pj.id = $1)
        AND ($2::bigint IS NULL OR r.sampling_batch_id = $2)
        AND ($3::text IS NULL OR r.status = $3)
        AND ($4::text IS NULL OR r.account_key = $4)
        AND ($5::text IS NULL OR r.error_code = $5)
        AND ($6::text IS NULL OR r.provider = $6)
        AND ($7::text = '' OR r.search_text ILIKE '%' || $7 || '%')`,
    [projectId, batchId, status, accountKey, errorCode, provider, term],
  );
  return rows[0]?.total ?? 0;
}

/**
 * 对话档案：一次带出问题、回答、引用域名摘要。
 *
 * 引用域名用 LATERAL 子查询单独聚合，而不是 JOIN citations 后 GROUP BY：
 * 后者会把 run 行复制成「引用数」行，answer 正文随之被重复传输 ——
 * 一次 100 行的档案页能传出几 MB，页面直接卡住。
 */
export async function listConversations(
  pool,
  {
    batchId = null,
    projectId = null,
    provider = null,
    query = null,
    limit = 60,
    offset = 0,
  } = {},
) {
  const term = query ? String(query) : "";
  return (
    await pool.query(
      `SELECT r.id, r.local_run_id, r.status, r.provider, r.started_at, r.finished_at,
              r.answer, length(r.answer) AS answer_chars,
              r.answer_truncated, r.answer_completion, r.brand_mentioned, r.mention_count,
              r.captured_citation_count, r.expected_citation_count, r.citation_state,
              r.error_code, r.error_message, r.account_key, r.sampling_batch_id,
              pr.prompt, pj.name AS project_name, sb.name AS batch_name,
              dom.domains AS cite_domains
         FROM runs r
         JOIN prompts pr ON pr.id = r.prompt_id
         JOIN projects pj ON pj.id = pr.project_id
         LEFT JOIN sampling_batches sb ON sb.id = r.sampling_batch_id
         LEFT JOIN LATERAL (
           SELECT array_agg(DISTINCT a.normalized_domain) AS domains
             FROM citations c
             JOIN articles a ON a.id = c.article_id
            WHERE c.run_id = r.id
              AND c.source_type = 'visible'
              AND c.visible_to_user IS TRUE
         ) dom ON true
        WHERE ($1::bigint IS NULL OR r.sampling_batch_id = $1)
          AND ($2::bigint IS NULL OR pj.id = $2)
          AND ($3::text IS NULL OR r.provider = $3)
          AND ($4::text = '' OR r.search_text ILIKE '%' || $4 || '%')
        ORDER BY r.started_at DESC
        LIMIT $5 OFFSET $6`,
      [batchId, projectId, provider, term, limit, offset],
    )
  ).rows;
}

/**
 * 找出「共享问题最多」的两个跨平台批次。
 *
 * 配对键必须是**问题文本**，不是 prompt_id：每个批次会为自己的问题池
 * 新建 prompts 行，同一个问题在批次 68 是 id=381、在批次 69 可能是 id=481，
 * 两边 prompt_id 交集为 0。按文本配对实测能正确识别出 68/69 的 50 个共享问题。
 *
 * 也不能按「最新两个不同平台」挑：最近的批次往往是冒烟测试，彼此没有共享
 * 问题，并排区会空着。这里让数据库按真实重叠数排序，并强制 provider 不同。
 */
export async function bestComparisonPair(pool, { projectId = null } = {}) {
  const { rows } = await pool.query(
    `WITH batch_prompts AS (
       SELECT DISTINCT r.sampling_batch_id AS batch_id, r.provider, pr.prompt
         FROM runs r
         JOIN prompts pr ON pr.id = r.prompt_id
        WHERE r.sampling_batch_id IS NOT NULL
          AND ($1::bigint IS NULL OR pr.project_id = $1)
     )
     SELECT a.batch_id AS left_batch, b.batch_id AS right_batch,
            a.provider AS left_provider, b.provider AS right_provider,
            count(*)::int AS overlap
       FROM batch_prompts a
       JOIN batch_prompts b
         ON a.prompt = b.prompt
        AND a.batch_id < b.batch_id
        AND a.provider <> b.provider
      GROUP BY a.batch_id, b.batch_id, a.provider, b.provider
      ORDER BY overlap DESC, a.batch_id DESC, b.batch_id DESC
      LIMIT 1`,
    [projectId],
  );
  if (!rows.length) return null;
  const row = rows[0];
  return {
    leftBatch: row.left_batch,
    rightBatch: row.right_batch,
    leftProvider: row.left_provider,
    rightProvider: row.right_provider,
    overlap: row.overlap,
  };
}

/** 档案页分组头：按批次给出真实口径，不复用任何估算值。 */
export async function conversationBatchSummary(pool, { projectId = null } = {}) {
  return (
    await pool.query(
      `SELECT b.id AS batch_id, b.name AS batch_name, b.status AS batch_status,
              b.created_at, r.provider,
              count(DISTINCT r.id)::int AS runs,
              count(DISTINCT r.id) FILTER (WHERE r.status = 'success')::int AS success,
              count(DISTINCT r.id) FILTER (WHERE r.status = 'partial')::int AS partial,
              count(DISTINCT r.id) FILTER (WHERE r.status = 'failed')::int AS failed,
              count(DISTINCT r.id) FILTER (WHERE length(coalesce(r.answer,'')) > 0)::int AS with_answer,
              count(c.id)::int AS citations,
              count(DISTINCT c.article_id)::int AS unique_articles,
              count(DISTINCT a.normalized_domain)::int AS domains
         FROM sampling_batches b
         JOIN runs r ON r.sampling_batch_id = b.id
         LEFT JOIN citations c ON c.run_id = r.id
             AND c.source_type = 'visible' AND c.visible_to_user IS TRUE
         LEFT JOIN articles a ON a.id = c.article_id
        WHERE ($1::bigint IS NULL OR b.project_id = $1)
        GROUP BY b.id, b.name, b.status, b.created_at, r.provider
        ORDER BY b.id DESC`,
      [projectId],
    )
  ).rows;
}

/** 筛选下拉需要的去重取值，避免让操作者手打错误码。 */
export async function runFilterOptions(pool) {
  const [accounts, errors] = await Promise.all([
    pool.query(
      `SELECT DISTINCT account_key FROM runs WHERE account_key IS NOT NULL ORDER BY account_key`,
    ),
    pool.query(
      `SELECT error_code, count(*) AS runs FROM runs
        WHERE error_code IS NOT NULL GROUP BY 1 ORDER BY runs DESC`,
    ),
  ]);
  return {
    accounts: accounts.rows.map((row) => row.account_key),
    errorCodes: errors.rows.map((row) => ({ code: row.error_code, runs: Number(row.runs) })),
  };
}

export async function getRun(pool, localRunId) {
  const { rows } = await pool.query(
    `SELECT r.*, pr.prompt, pj.name AS project_name, pj.id AS project_id, pj.target_brand,
            sb.name AS batch_name
       FROM runs r
       JOIN prompts pr ON pr.id = r.prompt_id
       JOIN projects pj ON pj.id = pr.project_id
       LEFT JOIN sampling_batches sb ON sb.id = r.sampling_batch_id
      WHERE r.local_run_id = $1`,
    [localRunId],
  );
  return rows[0] ?? null;
}

export async function getRunCitations(pool, runId) {
  return (
    await pool.query(
      `SELECT c.source_position, c.citation_marker, c.relation_status, c.captured_from,
             c.visible_to_user, c.source_type, c.answer_text, c.tracked_article_id,
             a.canonical_url, a.original_url, a.title, a.domain, a.normalized_domain
         FROM citations c
         JOIN articles a ON a.id = c.article_id
        WHERE c.run_id = $1
        ORDER BY c.source_position`,
      [runId],
    )
  ).rows;
}

export async function sourceAggregates(pool, { projectId = null, batchId = null, limit = 25 } = {}) {
  const domains = (
    await pool.query(
      `SELECT a.normalized_domain AS domain,
              count(*)                                AS citations,
              count(DISTINCT a.id)                    AS articles,
              count(DISTINCT r.id)                    AS runs,
              count(DISTINCT r.prompt_id)             AS prompts
         FROM citations c
         JOIN articles a ON a.id = c.article_id
         JOIN runs r ON r.id = c.run_id
         JOIN prompts pr ON pr.id = r.prompt_id
        WHERE ($1::bigint IS NULL OR pr.project_id = $1)
          AND ($2::bigint IS NULL OR r.sampling_batch_id = $2)
          AND ${CITATION_VALID_RUN_SQL}
          AND ${VISIBLE_CITATION_SQL}
        GROUP BY 1
        ORDER BY citations DESC, domain
        LIMIT $3`,
      [projectId, batchId, limit],
    )
  ).rows;

  const articles = (
    await pool.query(
      `SELECT a.canonical_url, a.title, a.domain, a.normalized_domain,
              count(*)                    AS citations,
              count(DISTINCT r.id)        AS runs,
              count(DISTINCT r.prompt_id) AS prompts,
              bool_or(c.tracked_article_id IS NOT NULL) AS is_tracked
         FROM citations c
         JOIN articles a ON a.id = c.article_id
         JOIN runs r ON r.id = c.run_id
         JOIN prompts pr ON pr.id = r.prompt_id
        WHERE ($1::bigint IS NULL OR pr.project_id = $1)
          AND ($2::bigint IS NULL OR r.sampling_batch_id = $2)
          AND ${CITATION_VALID_RUN_SQL}
          AND ${VISIBLE_CITATION_SQL}
        GROUP BY a.id
        ORDER BY citations DESC, a.canonical_url
        LIMIT $3`,
      [projectId, batchId, limit],
    )
  ).rows;

  const [totals] = (
    await pool.query(
      `SELECT count(*) AS citations,
              count(DISTINCT a.id) AS articles,
              count(DISTINCT a.normalized_domain) AS domains
         FROM citations c
         JOIN articles a ON a.id = c.article_id
         JOIN runs r ON r.id = c.run_id
         JOIN prompts pr ON pr.id = r.prompt_id
        WHERE ($1::bigint IS NULL OR pr.project_id = $1)
          AND ($2::bigint IS NULL OR r.sampling_batch_id = $2)
          AND ${CITATION_VALID_RUN_SQL}
          AND ${VISIBLE_CITATION_SQL}`,
      [projectId, batchId],
    )
  ).rows;

  return { domains, articles, totals };
}

/** 新建项目。关键词池留空，由项目经理在关键词池页面人工录入。 */
export async function createProject(pool, { name, description = null, targetBrand = null }) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) throw new Error("项目名称不能为空");

  const { rows } = await pool.query(
    `INSERT INTO projects (name, description, target_brand)
     VALUES ($1, $2, $3)
     ON CONFLICT (name) DO NOTHING
     RETURNING id`,
    [trimmed, description, targetBrand],
  );

  if (rows[0]) return { id: Number(rows[0].id), created: true };

  const existing = await pool.query("SELECT id FROM projects WHERE name = $1", [trimmed]);
  if (!existing.rows[0]) throw new Error(`项目「${trimmed}」创建失败`);
  return { id: Number(existing.rows[0].id), created: false };
}

export async function setProjectBrand(
  pool,
  { projectId, targetBrand, aliases = [], productAliases = [], excludePatterns = [] },
) {
  await pool.query(
    `UPDATE projects
        SET target_brand = $2,
            brand_aliases = $3::jsonb,
            brand_product_aliases = $4::jsonb,
            brand_exclude_patterns = $5::jsonb,
            updated_at = now()
      WHERE id = $1`,
    [
      projectId,
      targetBrand,
      JSON.stringify(aliases),
      JSON.stringify(productAliases),
      JSON.stringify(excludePatterns),
    ],
  );
}

export async function batchDetail(pool, batchId) {
  const [report, runs, sources, intelligence] = await Promise.all([
    buildBatchReport(pool, batchId),
    listRuns(pool, { batchId, limit: 500 }),
    sourceAggregates(pool, { batchId, limit: 15 }),
    buildBrandSourceIntelligence(pool, batchId),
  ]);
  return { report, runs, sources, intelligence };
}
