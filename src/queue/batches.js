import { Queue } from "bullmq";
import { safetyConfig } from "../accounts/safety.js";
import { accountQueueName, getRedis, isQueueConfigured } from "./connection.js";
import { loadBatch, loadBatchAssignments } from "../sampling/batch.js";

/**
 * 批次任务入队、停止与进度刷新。
 *
 * 幂等设计有三层：
 *   1. run_token = b<批次>_i<分配序号>，每个分配全局唯一
 *   2. BullMQ 的 jobId 用同一个 token，重复入队会被忽略
 *   3. runs.run_token 上有唯一索引，即使数据库被并发写入也不会出现两条
 * 因此重复点击「开始监测」不会让同一个批次跑两遍。
 */

export function runTokenFor(batchId, selectionIndex) {
  return `b${batchId}_i${selectionIndex}`;
}

/** 确定性 runId：队列重试复用同一个本地产物目录与同一条数据库记录。 */
export function runIdFor(batchId, selectionIndex) {
  return `run_b${batchId}_i${selectionIndex}`;
}

const TERMINAL_JOB_STATES = new Set(["completed", "failed"]);

export async function enqueueBatch(pool, batchId, { log = console.log } = {}) {
  if (!isQueueConfigured()) {
    return { started: false, reason: "REDIS_URL 未配置，无法使用后台队列" };
  }

  const batch = await loadBatch(pool, batchId);
  const assignments = await loadBatchAssignments(pool, batchId);
  if (!assignments.length) {
    return { started: false, reason: "该批次没有分配任何提问" };
  }

  const byAccount = new Map();
  for (const assignment of assignments) {
    const key = assignment.accountKey;
    if (!byAccount.has(key)) byAccount.set(key, []);
    byAccount.get(key).push(assignment);
  }

  // 幂等判定不只看状态：如果状态是 running 但队列里已经没有活任务了
  // （例如 Worker 崩溃、或上一次执行失败收尾），应当允许重新启动。
  let liveJobs = 0;
  for (const accountKey of byAccount.keys()) {
    const queue = new Queue(accountQueueName(accountKey), { connection: getRedis() });
    try {
      const jobs = await queue.getJobs(["waiting", "active", "delayed", "paused"], 0, 500);
      liveJobs += jobs.filter((job) => job.data?.batchId === batchId).length;
    } catch {
      // 拿不到队列状态时按「没有活任务」处理，避免批次永久卡死
    } finally {
      await queue.close().catch(() => undefined);
    }
  }

  if (liveJobs > 0 && (batch.status === "queued" || batch.status === "running")) {
    return { started: false, reason: "该批次已在队列中或正在执行", alreadyActive: true };
  }

  let enqueued = 0;

  for (const [accountKey, accountAssignments] of byAccount) {
    const queue = new Queue(accountQueueName(accountKey), { connection: getRedis() });
    try {
      // 允许重跑失败或中止的批次：先清掉已经终止的旧任务。
      // 仍在等待中的任务保留，保持 jobId 幂等。
      for (const assignment of accountAssignments) {
        const jobId = runTokenFor(batchId, assignment.selectionIndex);
        const existing = await queue.getJob(jobId);
        if (!existing) continue;
        const state = await existing.getState();
        if (TERMINAL_JOB_STATES.has(state)) {
          await existing.remove().catch(() => undefined);
        }
      }

      const jobs = accountAssignments
        .filter((assignment) => assignment.accountKey === accountKey)
        .map((assignment) => ({
          name: "run-prompt",
          data: {
            batchId,
            selectionIndex: assignment.selectionIndex,
            accountKey,
            projectName: batch.project_name,
            promptId: assignment.promptId,
          },
          opts: {
            jobId: runTokenFor(batchId, assignment.selectionIndex),
            // 首次 + 2 次重试；不可重试的错误会在处理器里抛 UnrecoverableError
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
        SET status = 'queued', queued_at = now(), aborted_at = NULL,
            requested_jobs = $2, skipped_jobs = 0, finished_at = NULL
      WHERE id = $1`,
    [batchId, assignments.length],
  );

  log(`批次 #${batchId} 已入队：${enqueued} 个任务，覆盖 ${byAccount.size} 个账号`);
  for (const [accountKey, list] of byAccount) {
    log(`  账号 ${accountKey}: ${list.length} 个任务`);
  }

  return { started: true, enqueued, accounts: [...byAccount.keys()] };
}

export async function stopBatch(pool, batchId, { log = console.log } = {}) {
  const { rowCount } = await pool.query(
    `UPDATE sampling_batches
        SET status = 'aborted', aborted_at = now()
      WHERE id = $1 AND status IN ('queued', 'running')`,
    [batchId],
  );

  if (!rowCount) {
    return { stopped: false, reason: "该批次不在执行中，无需停止" };
  }

  let removed = 0;
  if (isQueueConfigured()) {
    const assignments = await loadBatchAssignments(pool, batchId);
    const accounts = [...new Set(assignments.map((a) => a.accountKey))];

    for (const accountKey of accounts) {
      const queue = new Queue(accountQueueName(accountKey), { connection: getRedis() });
      try {
        // 只移除还没被领取的任务；正在执行的任务会自行安全结束
        const pending = await queue.getJobs(["waiting", "delayed", "paused"], 0, 500);
        for (const job of pending) {
          if (job.data?.batchId !== batchId) continue;
          await job.remove().catch(() => undefined);
          removed += 1;
        }
      } finally {
        await queue.close().catch(() => undefined);
      }
    }
  }

  await pool.query(
    `UPDATE sampling_batches SET skipped_jobs = skipped_jobs + $2, last_heartbeat_at = now() WHERE id = $1`,
    [batchId, removed],
  );

  log(`批次 #${batchId} 已停止：移除排队任务 ${removed} 个，已在执行的任务会安全结束`);
  return { stopped: true, removed };
}

/** 从 runs 表重算进度，并决定批次终态。以数据库为准，重复调用是安全的。 */
export async function refreshBatchProgress(pool, batchId) {
  const { rows } = await pool.query(
    `SELECT b.status, b.requested_jobs, b.skipped_jobs,
            (SELECT count(*) FROM runs r
              WHERE r.sampling_batch_id = b.id AND r.status IN ('success', 'partial')) AS completed,
            (SELECT count(*) FROM runs r
              WHERE r.sampling_batch_id = b.id AND r.status = 'failed') AS failed
       FROM sampling_batches b
      WHERE b.id = $1`,
    [batchId],
  );

  const row = rows[0];
  if (!row) return null;

  const completed = Number(row.completed);
  const failed = Number(row.failed);
  const requested = Number(row.requested_jobs);
  const skipped = Number(row.skipped_jobs);

  let status = row.status;
  let finished = false;

  if (status !== "aborted") {
    if (requested > 0 && completed + failed + skipped >= requested) {
      status = completed === 0 && failed > 0 ? "failed" : failed > 0 ? "partial" : "completed";
      finished = true;
    } else {
      status = "running";
    }
  }

  await pool.query(
    `UPDATE sampling_batches
        SET completed_jobs = $2,
            failed_jobs = $3,
            status = $4,
            last_heartbeat_at = now(),
            started_at = CASE WHEN $4 = 'running' THEN COALESCE(started_at, now()) ELSE started_at END,
            finished_at = CASE WHEN $5 THEN COALESCE(finished_at, now()) ELSE finished_at END
      WHERE id = $1`,
    [batchId, completed, failed, status, finished],
  );

  return { status, requested, completed, failed, skipped };
}

/** 批次状态 + 队列中还未领取的任务数，用于进度页面。 */
export async function batchProgress(pool, batchId) {
  const { rows } = await pool.query(
    `SELECT b.id, b.name, b.status, b.requested_jobs, b.completed_jobs, b.failed_jobs, b.skipped_jobs,
            b.started_at, b.finished_at, b.queued_at, b.aborted_at, b.last_heartbeat_at,
            p.name AS project_name, p.target_brand
       FROM sampling_batches b
       JOIN projects p ON p.id = b.project_id
      WHERE b.id = $1`,
    [batchId],
  );

  const batch = rows[0];
  if (!batch) return null;

  const requested = Number(batch.requested_jobs);
  const completed = Number(batch.completed_jobs);
  const failed = Number(batch.failed_jobs);
  const skipped = Number(batch.skipped_jobs);
  const done = completed + failed + skipped;

  // 队列计数必须按 batchId 过滤：同一账号队列里可能有多个批次的任务。
  // 只统计 active —— 它的数量很小（每个账号至多一个），而排队数用数据库计数
  // 反推，避免把别的批次或已作废的任务算进来。
  let activeScoped = 0;
  if (isQueueConfigured()) {
    const assignments = await loadBatchAssignments(pool, batchId);
    const accounts = [...new Set(assignments.map((a) => a.accountKey))];

    for (const accountKey of accounts) {
      const queue = new Queue(accountQueueName(accountKey), { connection: getRedis() });
      try {
        const activeJobs = await queue.getJobs(["active"], 0, 100);
        activeScoped += activeJobs.filter((job) => job.data?.batchId === batchId).length;
      } catch {
        // Redis 暂时不可用时进度仍以数据库计数为准
      } finally {
        await queue.close().catch(() => undefined);
      }
    }
  }

  // BullMQ 的 active 会把「已被账号 worker 领取、但还在等并行闸门」的任务也算进去。
  // 面板上的「运行中」应当表示真正在跑的账号数，所以按账号并行度封顶。
  const parallelism = safetyConfig().accountParallelism;
  const runningNow = Math.min(activeScoped, parallelism);
  const remaining = Math.max(0, requested - done);
  const waiting = Math.max(0, remaining - runningNow);

  return {
    batch,
    counts: {
      requested,
      completed,
      failed,
      skipped,
      waiting,
      active: runningNow,
      parallelism,
      done,
      percent: requested ? Math.round((done / requested) * 100) : 0,
    },
    active: ["queued", "running"].includes(batch.status),
  };
}
