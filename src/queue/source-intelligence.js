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
              WHERE apo.article_id IS NOT NULL
                AND NOT (
                  apo.fetch_state = 'success'
                  AND COALESCE(apo.content_profile, '{}'::jsonb) <> '{}'::jsonb
                )
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
 * Queue the cited-page analysis exactly once for the current batch generation.
 * The DB state claim happens before BullMQ add; on queue failure it is rolled back to idle.
 */
export async function enqueueSourceIntelligence(
  pool,
  batchId,
  { generation = null, log = console.log } = {},
) {
  if (!isQueueConfigured()) {
    return { scheduled: false, reason: "REDIS_URL 未配置" };
  }

  const { rows } = await pool.query(
    `SELECT id, status, source_intelligence_generation, source_intelligence_status
       FROM sampling_batches
      WHERE id = $1`,
    [batchId],
  );
  const batch = rows[0];
  if (!batch) return { scheduled: false, reason: "批次不存在" };
  if (!BATCHES_WITH_ANALYZABLE_RESULTS.has(batch.status)) {
    return { scheduled: false, reason: `批次状态 ${batch.status} 尚不进入引用页分析` };
  }

  const currentGeneration = Number(batch.source_intelligence_generation ?? 0);
  if (generation != null && Number(generation) !== currentGeneration) {
    return { scheduled: false, reason: "批次代次已变化", superseded: true };
  }
  if (batch.source_intelligence_status !== "idle") {
    return {
      scheduled: false,
      reason: `引用页分析状态已是 ${batch.source_intelligence_status}`,
      alreadyScheduled: true,
      status: batch.source_intelligence_status,
    };
  }

  const claimed = await pool.query(
    `UPDATE sampling_batches
        SET source_intelligence_status = 'queued',
            source_intelligence_queued_at = now(),
            source_intelligence_started_at = NULL,
            source_intelligence_finished_at = NULL,
            source_intelligence_error = NULL
      WHERE id = $1
        AND source_intelligence_generation = $2
        AND source_intelligence_status = 'idle'
      RETURNING id`,
    [batchId, currentGeneration],
  );
  if (!claimed.rowCount) {
    return { scheduled: false, reason: "引用页分析已被其他进程调度", alreadyScheduled: true };
  }

  const queue = new Queue(sourceIntelligenceQueueName(), { connection: getRedis() });
  const jobId = sourceIntelligenceJobId(batchId, currentGeneration);
  try {
    const existing = await queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (TERMINAL_JOB_STATES.has(state)) await existing.remove().catch(() => undefined);
      else {
        log(`引用页分析任务已存在：batch=${batchId} generation=${currentGeneration} state=${state}`);
        return { scheduled: true, alreadyScheduled: true, jobId, generation: currentGeneration };
      }
    }

    await queue.add(
      "analyze-cited-sources",
      { batchId: Number(batchId), generation: currentGeneration },
      {
        jobId,
        attempts: 2,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: false,
        removeOnFail: false,
      },
    );
    log(`引用页分析已入队：batch=${batchId} generation=${currentGeneration}`);
    return { scheduled: true, jobId, generation: currentGeneration };
  } catch (error) {
    await pool.query(
      `UPDATE sampling_batches
          SET source_intelligence_status = 'idle',
              source_intelligence_error = $3
        WHERE id = $1
          AND source_intelligence_generation = $2
          AND source_intelligence_status = 'queued'`,
      [batchId, currentGeneration, error instanceof Error ? error.message : String(error)],
    );
    throw error;
  } finally {
    await queue.close().catch(() => undefined);
  }
}

export async function markSourceIntelligenceRunning(pool, batchId, generation) {
  const { rowCount } = await pool.query(
    `UPDATE sampling_batches
        SET source_intelligence_status = 'running',
            source_intelligence_started_at = now(),
            source_intelligence_finished_at = NULL,
            source_intelligence_error = NULL
      WHERE id = $1
        AND source_intelligence_generation = $2
        AND source_intelligence_status IN ('queued', 'running')`,
    [batchId, generation],
  );
  return rowCount > 0;
}

export async function finishSourceIntelligence(pool, batchId, generation, { status, error = null }) {
  if (!["completed", "partial", "failed"].includes(status)) {
    throw new Error(`Invalid source intelligence terminal status: ${status}`);
  }
  const { rowCount } = await pool.query(
    `UPDATE sampling_batches
        SET source_intelligence_status = $3,
            source_intelligence_finished_at = now(),
            source_intelligence_error = $4
      WHERE id = $1 AND source_intelligence_generation = $2`,
    [batchId, generation, status, error],
  );
  return rowCount > 0;
}

export async function sourceIntelligenceState(pool, batchId) {
  const { rows } = await pool.query(
    `SELECT source_intelligence_generation AS generation,
            source_intelligence_status AS status,
            source_intelligence_queued_at AS queued_at,
            source_intelligence_started_at AS started_at,
            source_intelligence_finished_at AS finished_at,
            source_intelligence_error AS error
       FROM sampling_batches WHERE id = $1`,
    [batchId],
  );
  return rows[0] ?? null;
}
