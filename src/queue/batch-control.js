import { Queue } from "bullmq";

import { accountIdentity, accountQueueName, getRedis, isQueueConfigured } from "./connection.js";
import { accountQueueNamesFor, runTokenFor } from "./batches.js";
import { loadBatch, loadBatchAssignments } from "../sampling/batch.js";

const TERMINAL_RUN_STATES = new Set(["success", "partial", "failed"]);

export async function pauseBatch(pool, batchId) {
  const { rowCount } = await pool.query(
    `UPDATE sampling_batches
        SET status = 'paused', last_heartbeat_at = now()
      WHERE id = $1 AND status IN ('queued', 'running')`,
    [batchId],
  );
  if (!rowCount) return { paused: false, reason: "batch is not currently running" };

  let removed = 0;
  if (isQueueConfigured()) {
    const assignments = await loadBatchAssignments(pool, batchId);
    for (const name of accountQueueNamesFor(assignments)) {
      const queue = new Queue(name, { connection: getRedis() });
      try {
        const jobs = await queue.getJobs(["waiting", "delayed", "paused"], 0, 500);
        for (const job of jobs) {
          if (job.data?.batchId !== batchId) continue;
          await job.remove().catch(() => undefined);
          removed += 1;
        }
      } finally {
        await queue.close().catch(() => undefined);
      }
    }
  }
  return { paused: true, removed_pending_jobs: removed };
}

export async function resumeBatch(pool, batchId) {
  if (!isQueueConfigured()) return { resumed: false, reason: "REDIS_URL is not configured" };
  const batch = await loadBatch(pool, batchId);
  if (batch.status !== "paused") return { resumed: false, reason: "batch is not paused" };

  const assignments = await loadBatchAssignments(pool, batchId);
  const { rows: finishedRuns } = await pool.query(
    `SELECT run_token, status
       FROM runs
      WHERE sampling_batch_id = $1 AND run_token IS NOT NULL`,
    [batchId],
  );
  const settled = new Set(
    finishedRuns.filter((row) => TERMINAL_RUN_STATES.has(row.status)).map((row) => row.run_token),
  );

  const remaining = assignments.filter((assignment) => !settled.has(runTokenFor(batchId, assignment.selectionIndex)));
  // 分组键必须是 (平台, 账号)：只在豆包队列里排过的账号，重跑时不能落到别的平台队列上。
  const byAccount = new Map();
  for (const assignment of remaining) {
    const key = accountIdentity(assignment.accountKey, assignment.provider);
    if (!byAccount.has(key)) byAccount.set(key, []);
    byAccount.get(key).push(assignment);
  }

  let enqueued = 0;
  for (const rows of byAccount.values()) {
    const { accountKey, provider } = rows[0];
    const queue = new Queue(accountQueueName(accountKey, provider), { connection: getRedis() });
    try {
      const jobs = rows.map((assignment) => ({
        name: "run-prompt",
        data: {
          batchId,
          selectionIndex: assignment.selectionIndex,
          accountKey,
          provider,
          projectName: batch.project_name,
          promptId: assignment.promptId,
        },
        opts: {
          jobId: runTokenFor(batchId, assignment.selectionIndex),
          attempts: 3,
          backoff: { type: "exponential", delay: 5_000 },
          removeOnComplete: false,
          removeOnFail: false,
        },
      }));
      if (jobs.length) {
        await queue.addBulk(jobs);
        enqueued += jobs.length;
      }
    } finally {
      await queue.close().catch(() => undefined);
    }
  }

  await pool.query(
    `UPDATE sampling_batches
        SET status = CASE WHEN $2 = 0 THEN 'running' ELSE 'queued' END,
            queued_at = CASE WHEN $2 = 0 THEN queued_at ELSE now() END,
            aborted_at = NULL,
            last_heartbeat_at = now()
      WHERE id = $1 AND status = 'paused'`,
    [batchId, remaining.length],
  );

  return { resumed: true, remaining: remaining.length, enqueued };
}
