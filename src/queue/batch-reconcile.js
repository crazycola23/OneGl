import { Queue } from "bullmq";
import { accountQueueName, getRedis, isQueueConfigured } from "./connection.js";
import { loadBatchAssignments } from "../sampling/batch.js";

/**
 * 批次对账：找出「已经终结、但 runs 表里没有任何记录」的任务。
 *
 * 为什么必须有这一步：一个任务的失败点可能在 RunStore.createRun 之前 —— 领取任务之后
 * 的提交节流、连接建立、锁获取这些阶段都不写 runs 表。只按 runs 表统计进度时，
 * 这些任务既不算完成也不算失败，批次会永远停在「差几条」上：
 * 队列里早已没有活任务，界面却显示 running。
 *
 * 队列的 failed 集合是这件事唯一的事实来源，runs 表只是它的投影，投影可能缺行。
 *
 * 这里刻意不 import batches.js 的 accountQueueNamesFor：batches.js 需要调用本模块，
 * 反向引用会形成循环。队列名算法只有一行，重复一次比绕开循环依赖更安全。
 */

/** 单条队列最多回看多少个终结任务。批次规模是几百，留一个能覆盖历史积压的上限。 */
const FAILED_SCAN_LIMIT = 5_000;

export async function countOrphanFailedJobs(pool, batchId) {
  if (!isQueueConfigured()) return 0;

  const assignments = await loadBatchAssignments(pool, batchId);
  if (!assignments.length) return 0;

  const queueNames = [...new Set(
    assignments.map((assignment) => accountQueueName(assignment.accountKey, assignment.provider)),
  )];

  const jobIds = new Set();
  for (const name of queueNames) {
    const queue = new Queue(name, { connection: getRedis() });
    try {
      const failed = await queue.getJobs(["failed"], 0, FAILED_SCAN_LIMIT, false);
      for (const job of failed) {
        if (job?.data?.batchId === batchId) jobIds.add(String(job.id));
      }
    } catch {
      // Redis 读不到时按 0 处理：宁可这一轮少算几条（下一次事件会再算），
      // 也不要把一个还在跑的任务误判成失败从而提前收口批次。
      return 0;
    } finally {
      await queue.close().catch(() => undefined);
    }
  }

  if (!jobIds.size) return 0;

  const { rows } = await pool.query(
    `SELECT run_token FROM runs WHERE sampling_batch_id = $1`,
    [batchId],
  );
  const recorded = new Set(rows.map((row) => String(row.run_token)));

  let orphan = 0;
  for (const id of jobIds) {
    if (!recorded.has(id)) orphan += 1;
  }
  return orphan;
}

/**
 * 列出「已经终结、但没有 runs 记录」的任务明细，供人工恢复时判断能不能重跑。
 *
 * 与 countOrphanFailedJobs 分开是因为用途不同：进度收口只要一个数字且必须便宜，
 * 恢复工具需要 job id 和失败原因，可以慢。
 */
export async function listOrphanFailedJobs(pool, batchId) {
  if (!isQueueConfigured()) return { orphans: [], queueNames: [] };

  const assignments = await loadBatchAssignments(pool, batchId);
  if (!assignments.length) return { orphans: [], queueNames: [] };

  const queueNames = [...new Set(
    assignments.map((assignment) => accountQueueName(assignment.accountKey, assignment.provider)),
  )];

  const byId = new Map();
  for (const name of queueNames) {
    const queue = new Queue(name, { connection: getRedis() });
    try {
      const failed = await queue.getJobs(["failed"], 0, FAILED_SCAN_LIMIT, false);
      for (const job of failed) {
        if (job?.data?.batchId === batchId) byId.set(String(job.id), job);
      }
    } finally {
      await queue.close().catch(() => undefined);
    }
  }

  const { rows } = await pool.query(
    `SELECT run_token FROM runs WHERE sampling_batch_id = $1`,
    [batchId],
  );
  const recorded = new Set(rows.map((row) => String(row.run_token)));

  const orphans = [...byId.values()]
    .filter((job) => !recorded.has(String(job.id)))
    .sort((a, b) => (a.data?.selectionIndex ?? 0) - (b.data?.selectionIndex ?? 0));

  return { orphans, queueNames };
}
