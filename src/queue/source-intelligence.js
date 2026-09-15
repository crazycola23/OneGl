import { Queue } from "bullmq";
import { getRedis, isQueueConfigured, sourceIntelligenceQueueName } from "./connection.js";

const BATCHES_WITH_ANALYZABLE_RESULTS = new Set(["completed", "partial"]);
const TERMINAL_JOB_STATES = new Set(["completed", "failed"]);

export function sourceIntelligenceJobId(batchId, generation) {
  return `source-intelligence-b${Number(batchId)}-g${Number(generation)}`;
}

/**
 * Count only final user-visible citations. Page analysis is a secondary background stage;
 * these numbers never alter the sampling batch status.
 */
export async function sourceIntelligenceCoverage(pool, batchId) {
  const { rows } = await pool.query(
    `WITH cited AS (
       SELECT DISTINCT c.article_id
         FROM citations c
         JOIN runs r ON r.id = c.run_id
        WHERE r.sampling_batch_id = $1
          AND c.visible_to_user IS NOT FALSE
          AND c.article_id IS NOT NULL
     )
     SELECT count(*) AS cited_sources,
            count(*) FILTER (
              WHERE apo.fetch_state = 'success'
                AND COALESCE(apo.content_profile, '{}'::jsonb) <> '{}'::jsonb
            ) AS analyzed_sources,
            count(*) FILTER (
              WHERE apo.fetch_state = 'success'
                AND COALESCE(apo.content_profile, '{}'::jsonb) <> '{}'::jsonb
                AND apo.brand_mentioned IS TRUE
            ) AS brand_evidence_sources,
            count(*) FILTER (
              WHERE apo.article_id IS NULL
                 OR apo.fetch_state <> 'success'
                 OR COALESCE(apo.content_profile, '{}'::jsonb) = '{}'::jsonb
            ) AS unresolved_sources
       FROM cited
       LEFT JOIN article_page_observations apo
         ON apo.batch_id = $1 AND apo.article_id = cited.article_id`,
    [batchId],
  );
  const row = rows[0] ?? {};
  return {
    citedSources: Number(row.cited_sources ?? 0),
    analyzedSources: Number(row.analyzed_sources ?? 0),
    brandEvidenceSources: Number(row.brand_evidence_sources ?? 0),
    unresolvedSources: Number(row.unresolved_sources ?? 0),
  };
}

/**
 * Find batches whose user-visible citation set is newer than the last intelligence pass.
 * This is what makes the scheduler self-healing: old completed batches are backfilled, and
 * re-running the same batch id automatically creates a new intelligence generation.
 */
export async function listSourceIntelligenceBacklog(pool, { limit = 20 } = {}) {
  return (
    await pool.query(
      `SELECT id
         FROM sampling_batches
        WHERE status IN ('completed', 'partial')
          AND finished_at IS NOT NULL
          AND source_intelligence_status NOT IN ('queued', 'running')
          AND (
            source_intelligence_finished_at IS NULL
            OR source_intelligence_finished_at < finished_at
          )
        ORDER BY finished_at DESC, id DESC
        LIMIT $1`,
      [limit],
    )
  ).rows.map((row) => Number(row.id));
}

/**
 * Queue one fresh cited-page analysis generation when the sampling batch is stale.
 * The claim is atomic: concurrent reconcilers can race safely and only one increments the
 * generation. Queue failures roll the claim back to idle so a later reconciliation retries.
 */
export async function enqueueSourceIntelligence(pool, batchId, { log = console.log } = {}) {
  if (!isQueueConfigured()) {
    return { scheduled: false, reason: "REDIS_URL 未配置" };
  }

  const { rows } = await pool.query(
    `SELECT id, status, finished_at,
            source_intelligence_generation,
            source_intelligence_status,
            source_intelligence_finished_at
       FROM sampling_batches
      WHERE id = $1`,
    [batchId],
  );
  const batch = rows[0];
  if (!batch) return { scheduled: false, reason: "批次不存在" };
  if (!BATCHES_WITH_ANALYZABLE_RESULTS.has(batch.status) || !batch.finished_at) {
    return { scheduled: false, reason: `批次状态 ${batch.status} 尚不进入引用页分析` };
  }
  if (["queued", "running"].includes(batch.source_intelligence_status)) {
    return {
      scheduled: false,
      reason: `引用页分析状态已是 ${batch.source_intelligence_status}`,
      alreadyScheduled: true,
      status: batch.source_intelligence_status,
    };
  }

  const batchFinishedAtMs = Date.parse(batch.finished_at);
  const intelFinishedAt = batch.source_intelligence_finished_at
    ? Date.parse(batch.source_intelligence_finished_at)
    : Number.NaN;
  if (Number.isFinite(intelFinishedAt) && intelFinishedAt >= batchFinishedAtMs) {
    return {
      scheduled: false,
      reason: "引用页分析已覆盖当前批次结果",
      fresh: true,
      status: batch.source_intelligence_status,
    };
  }

  const claimed = await pool.query(
    `UPDATE sampling_batches
        SET source_intelligence_generation = source_intelligence_generation + 1,
            source_intelligence_status = 'queued',
            source_intelligence_queued_at = now(),
            source_intelligence_started_at = NULL,
            source_intelligence_finished_at = NULL,
            source_intelligence_error = NULL
      WHERE id = $1
        AND status IN ('completed', 'partial')
        AND finished_at IS NOT NULL
        AND source_intelligence_status NOT IN ('queued', 'running')
        AND (
          source_intelligence_finished_at IS NULL
          OR source_intelligence_finished_at < finished_at
        )
      RETURNING source_intelligence_generation AS generation, finished_at AS batch_finished_at`,
    [batchId],
  );
  if (!claimed.rowCount) {
    return { scheduled: false, reason: "引用页分析已被其他进程调度", alreadyScheduled: true };
  }

  const generation = Number(claimed.rows[0].generation);
  const batchFinishedAt = new Date(claimed.rows[0].batch_finished_at).toISOString();
  const queue = new Queue(sourceIntelligenceQueueName(), { connection: getRedis() });
  const jobId = sourceIntelligenceJobId(batchId, generation);
  try {
    const existing = await queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (TERMINAL_JOB_STATES.has(state)) await existing.remove().catch(() => undefined);
      else {
        log(`引用页分析任务已存在：batch=${batchId} generation=${generation} state=${state}`);
        return { scheduled: true, alreadyScheduled: true, jobId, generation, batchFinishedAt };
      }
    }

    await queue.add(
      "analyze-cited-sources",
      { batchId: Number(batchId), generation, batchFinishedAt },
      {
        jobId,
        attempts: 2,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: false,
        removeOnFail: false,
      },
    );
    log(`引用页分析已入队：batch=${batchId} generation=${generation}`);
    return { scheduled: true, jobId, generation, batchFinishedAt };
  } catch (error) {
    await pool.query(
      `UPDATE sampling_batches
          SET source_intelligence_status = 'idle',
              source_intelligence_error = $3
        WHERE id = $1
          AND source_intelligence_generation = $2
          AND source_intelligence_status = 'queued'`,
      [batchId, generation, error instanceof Error ? error.message : String(error)],
    );
    throw error;
  } finally {
    await queue.close().catch(() => undefined);
  }
}

export async function reconcileSourceIntelligence(pool, { limit = 20, log = console.log } = {}) {
  const batchIds = await listSourceIntelligenceBacklog(pool, { limit });
  const results = [];
  for (const batchId of batchIds) {
    try {
      results.push({ batchId, ...(await enqueueSourceIntelligence(pool, batchId, { log })) });
    } catch (error) {
      results.push({
        batchId,
        scheduled: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

export async function markSourceIntelligenceRunning(pool, batchId, generation, batchFinishedAt = null) {
  const { rowCount } = await pool.query(
    `UPDATE sampling_batches
        SET source_intelligence_status = 'running',
            source_intelligence_started_at = now(),
            source_intelligence_finished_at = NULL,
            source_intelligence_error = NULL
      WHERE id = $1
        AND source_intelligence_generation = $2
        AND source_intelligence_status IN ('queued', 'running')
        AND status IN ('completed', 'partial')
        AND ($3::timestamptz IS NULL OR finished_at = $3::timestamptz)`,
    [batchId, generation, batchFinishedAt],
  );
  return rowCount > 0;
}

export async function finishSourceIntelligence(
  pool,
  batchId,
  generation,
  { status, error = null, batchFinishedAt = null },
) {
  if (!["completed", "partial", "failed"].includes(status)) {
    throw new Error(`Invalid source intelligence terminal status: ${status}`);
  }
  const { rowCount } = await pool.query(
    `UPDATE sampling_batches
        SET source_intelligence_status = $3,
            source_intelligence_finished_at = now(),
            source_intelligence_error = $4
      WHERE id = $1
        AND source_intelligence_generation = $2
        AND status IN ('completed', 'partial')
        AND ($5::timestamptz IS NULL OR finished_at = $5::timestamptz)`,
    [batchId, generation, status, error, batchFinishedAt],
  );
  return rowCount > 0;
}

export async function sourceIntelligenceState(pool, batchId) {
  const { rows } = await pool.query(
    `SELECT status AS batch_status,
            finished_at AS batch_finished_at,
            source_intelligence_generation AS generation,
            source_intelligence_status AS status,
            source_intelligence_queued_at AS queued_at,
            source_intelligence_started_at AS started_at,
            source_intelligence_finished_at AS finished_at,
            source_intelligence_error AS error,
            CASE
              WHEN status IN ('completed', 'partial')
               AND finished_at IS NOT NULL
               AND (
                 source_intelligence_finished_at IS NULL
                 OR source_intelligence_finished_at < finished_at
               )
              THEN true ELSE false
            END AS stale
       FROM sampling_batches WHERE id = $1`,
    [batchId],
  );
  return rows[0] ?? null;
}
