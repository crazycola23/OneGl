import { Queue } from "bullmq";

import { ApiHttpError } from "../api/http.js";
import { accountQueueName, getRedis, isQueueConfigured } from "../queue/connection.js";

const JOB_STATES = ["waiting", "active", "delayed"];

function unavailable(message, details) {
  return new ApiHttpError(503, "queue_unavailable", message, details);
}

// 任何一次计数读取失败都归到同一个 503：调用方只需要区分「200 + 计数」和「判不了」。
function queueUnavailable(error) {
  if (error instanceof ApiHttpError) return error;
  return unavailable("in-flight job counts could not be read from the account queue", {
    message: error instanceof Error ? error.message : String(error),
  });
}

/** 与 reclaimTenantAccount 用同一条 JOIN 判存在，否则两个接口会对同一个 account_id 给出不同的 404。 */
async function resolveAccountKey(db, { tenantId, provider, externalId }) {
  const { rows } = await db.query(
    `SELECT b.account_key
       FROM service_account_bindings b
       JOIN accounts a ON a.provider = b.provider AND a.account_key = b.account_key
      WHERE b.tenant_id = $1 AND b.provider = $2 AND b.external_id = $3`,
    [tenantId, provider, externalId],
  );
  const accountKey = rows[0]?.account_key;
  if (!accountKey) throw new ApiHttpError(404, "account_not_found", `account ${externalId} was not found`);
  return accountKey;
}

/**
 * 账号队列里的在途任务数。
 *
 * 取不到计数一律抛 503：调用方把 0 读成「可以回收」，所以查询失败绝不能降级成 0。
 * 只读计数，不 pause、不 drain、不删任务；close() 只释放本次 Queue 实例，共享连接仍由 connection.js 持有。
 */
export async function countAccountQueueJobs(
  accountKey,
  { queueFactory = (name) => new Queue(name, { connection: getRedis() }) } = {},
) {
  if (!isQueueConfigured()) {
    throw unavailable("REDIS_URL is not configured, so in-flight jobs cannot be observed");
  }
  let queue = null;
  try {
    queue = queueFactory(accountQueueName(accountKey));
    const counts = await queue.getJobCounts(...JOB_STATES);
    const result = {};
    for (const state of JOB_STATES) {
      const value = Number(counts?.[state]);
      if (!Number.isInteger(value) || value < 0) {
        throw unavailable(`queue count for state ${state} is not observable`);
      }
      result[state] = value;
    }
    return result;
  } catch (error) {
    throw queueUnavailable(error);
  } finally {
    await queue?.close().catch(() => undefined);
  }
}

/**
 * 仍启用且引用了这个账号的排程/巡检计划。
 *
 * 计划里存的是 external_id 数组（src/monitor-worker.js 用它回查 service_account_bindings），
 * 账号软删后启用的计划仍会按 next_run_at 生成批次并把任务投进这条账号队列。
 * enabled_schedules 只数 SaaS 排程映射，enabled_monitor_plans 数所有启用计划（含排程背后的计划）。
 */
export async function countAccountReferences(db, { tenantId, externalId }) {
  const { rows } = await db.query(
    `SELECT
       (SELECT count(*)
          FROM service_task_schedules s
          JOIN service_monitor_plans sp ON sp.id = s.monitor_plan_id
         WHERE s.tenant_id = $1 AND sp.enabled AND sp.account_ids @> $2::jsonb) AS enabled_schedules,
       (SELECT count(*)
          FROM service_monitor_plans p
         WHERE p.tenant_id = $1 AND p.enabled AND p.account_ids @> $2::jsonb) AS enabled_monitor_plans`,
    [tenantId, JSON.stringify([externalId])],
  );
  const row = rows[0] ?? {};
  return {
    enabled_schedules: Number(row.enabled_schedules),
    enabled_monitor_plans: Number(row.enabled_monitor_plans),
  };
}

// NaN（计数没取到）不等于 0，宁可判不可回收。
const isZero = (value) => Number(value) === 0;

/** GET /v1/accounts/{accountId}/inflight 的判据：reclaim_safe 在服务端算完，调用方不再各自拼这几处计数。 */
export async function accountInflightState(
  db,
  { tenantId, externalId, provider = "doubao", queueCounter = countAccountQueueJobs } = {},
) {
  const external = String(externalId ?? "").trim();
  if (!external) throw new ApiHttpError(422, "invalid_account_id", "account_id is required");

  const accountKey = await resolveAccountKey(db, { tenantId, provider, externalId: external });
  let counts;
  try {
    counts = await queueCounter(accountKey);
  } catch (error) {
    // 计数拿不到就不可能给出 reclaim_safe：宁可 503，也不返回一个带 0 的「可以回收」。
    throw queueUnavailable(error);
  }
  const queue = Object.fromEntries(JOB_STATES.map((state) => [state, Number(counts?.[state])]));
  const referencing = await countAccountReferences(db, { tenantId, externalId: external });

  return {
    account_id: external,
    queue,
    referencing,
    reclaim_safe: JOB_STATES.every((state) => isZero(queue[state]))
      && isZero(referencing.enabled_schedules)
      && isZero(referencing.enabled_monitor_plans),
  };
}

export { JOB_STATES as ACCOUNT_INFLIGHT_JOB_STATES };
