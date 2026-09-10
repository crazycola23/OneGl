import { buildBatchReport } from "./report.js";

/**
 * Read-only queries that back the dashboard.
 *
 * The valid-run rule is repeated here in SQL so list pages stay a single round trip:
 * a run is a valid observation when it captured an answer (success or partial) from a
 * conversation that was confirmed empty.
 */
export const VALID_RUN_SQL =
  "r.status IN ('success', 'partial') AND r.conversation_reset_confirmed IS TRUE";

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
        (SELECT count(*) FROM articles)          AS articles,
        (SELECT count(*) FROM citations)         AS citations,
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
             (SELECT count(*) FROM prompts q WHERE q.project_id = p.id)                AS pool_size,
             (SELECT count(*) FROM prompts q WHERE q.project_id = p.id AND q.enabled)  AS pool_enabled,
             (SELECT count(*) FROM sampling_batches b WHERE b.project_id = p.id)       AS batch_count,
             (SELECT count(*) FROM tracked_articles t WHERE t.project_id = p.id AND t.enabled) AS tracked_count,
             (SELECT count(*)
                FROM runs r JOIN prompts q ON q.id = r.prompt_id
               WHERE q.project_id = p.id)                                              AS run_count,
             (SELECT count(*)
                FROM citations c JOIN runs r ON r.id = c.run_id
                JOIN prompts q ON q.id = r.prompt_id
               WHERE q.project_id = p.id)                                              AS citation_count
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
        WHERE project_id = $1
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
         LEFT JOIN citations c ON c.tracked_article_id = t.id
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
      SELECT a.account_key, a.provider, a.enabled, a.last_health_status, a.last_health_checked_at,
             (SELECT count(*) FROM runs r WHERE r.account_key = a.account_key) AS run_count
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
              p.name AS project_name, p.target_brand,
              count(r.id)                                                                AS runs_total,
              count(r.id) FILTER (WHERE ${VALID_RUN_SQL})                                AS valid_runs,
              count(r.id) FILTER (WHERE r.status = 'failed')                             AS failed_runs,
              count(r.id) FILTER (WHERE r.status = 'partial')                            AS partial_runs,
              count(r.id) FILTER (WHERE ${VALID_RUN_SQL} AND r.brand_mentioned)          AS mentioned_runs,
              count(DISTINCT r.prompt_id) FILTER (WHERE ${VALID_RUN_SQL})                AS prompts_total,
              count(DISTINCT r.prompt_id) FILTER (
                WHERE ${VALID_RUN_SQL} AND r.brand_mentioned)                            AS prompts_mentioned,
              COALESCE(sum(r.captured_citation_count), 0)                                AS citations,
              (SELECT count(*) FROM tracked_articles t WHERE t.project_id = b.project_id AND t.enabled) AS tracked_total,
              (SELECT count(DISTINCT c.tracked_article_id)
                 FROM citations c JOIN runs r2 ON r2.id = c.run_id
                WHERE r2.sampling_batch_id = b.id AND c.tracked_article_id IS NOT NULL)  AS tracked_cited
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

export async function listRuns(
  pool,
  { projectId = null, batchId = null, status = null, limit = 120 } = {},
) {
  return (
    await pool.query(
      `SELECT r.id, r.local_run_id, r.status, r.account_key, r.sampling_batch_id,
              r.started_at, r.finished_at, r.brand_mentioned, r.mention_count,
              r.expected_citation_count, r.captured_citation_count, r.citation_state,
              r.conversation_reset, r.conversation_reset_confirmed, r.error_code,
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
        ORDER BY r.started_at DESC
        LIMIT $4`,
      [projectId, batchId, status, limit],
    )
  ).rows;
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
              c.visible_to_user, c.answer_text, c.tracked_article_id,
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
          AND ($2::bigint IS NULL OR r.sampling_batch_id = $2)`,
      [projectId, batchId],
    )
  ).rows;

  return { domains, articles, totals };
}

export async function batchDetail(pool, batchId) {
  const report = await buildBatchReport(pool, batchId);
  const runs = await listRuns(pool, { batchId, limit: 500 });
  const sources = await sourceAggregates(pool, { batchId, limit: 15 });
  return { report, runs, sources };
}
