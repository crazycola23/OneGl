import "dotenv/config";
import { DelayedError, UnrecoverableError, Worker } from "bullmq";
import {
  ACCOUNT_BLOCKING_CODES,
  RETRYABLE_CODES,
  accountAvailability,
  beginAccountRun,
  markStorageStatePresent,
  randomDelayMs,
  recordAccountFailure,
  recordAccountSuccess,
  safetyConfig,
} from "./accounts/safety.js";
import { launchBrowserSession } from "./browser.js";
import { brandRulesFromConfig, runOnePrompt } from "./collect/runner.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { openDoubao } from "./doubao.js";
import { loadBrandRules } from "./project/init.js";
import { accountQueueName, closeRedis, getRedis, isQueueConfigured } from "./queue/connection.js";
import { refreshBatchProgress, runIdFor, runTokenFor } from "./queue/batches.js";
import { planUnavailableJob } from "./queue/job-plan.js";
import { RunStore } from "./store.js";

/**
 * 后台采集 Worker。
 *
 * 独立的进程，与 Web 进程互不影响：Web 只负责入队和展示，真正的
 * Camoufox / Playwright 长任务全部在这里执行。
 *
 * 采集逻辑直接复用 src/collect/runner.js（与命令行同一份内核），
 * 没有第二套登录判断、提问、回答与引用提取实现。
 */

if (!isQueueConfigured()) {
  console.error("REDIS_URL 未配置，Worker 无法启动。");
  process.exit(1);
}

const config = loadConfig();
const store = new RunStore(config);
const pool = createPool();
const safety = safetyConfig();
const prefix = process.env.ONEGL_QUEUE_PREFIX ?? "onegl";
const WORKER_CONCURRENCY_PER_ACCOUNT = 1;
// 一个临时冷却的任务最多被推迟几次。冷却本身不消耗重试次数，所以需要一个上限，
// 否则账号长期不可用（例如连续失败一直续冷却）时任务会无限期地挂着。
const MAX_COOLDOWN_WAITS = 3;

const sessions = new Map();
const brandRulesCache = new Map();
const workers = new Map();
let shuttingDown = false;

function log(fields) {
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${value}`);
  console.log(`[worker] ${parts.join(" ")}`);
}

/** 每个账号一个浏览器会话，复用以免每次任务都重启一次 Camoufox。 */
async function getSession(accountKey) {
  const existing = sessions.get(accountKey);
  if (existing) return existing;

  const accountConfig = loadConfig({ accountKey });
  const session = await launchBrowserSession(accountConfig);
  await openDoubao(session.page, accountConfig);
  await markStorageStatePresent(pool, accountKey, session.hasStoredAuth).catch(() => undefined);

  sessions.set(accountKey, session);
  log({ event: "session-open", account_key: accountKey, stored_auth: session.hasStoredAuth });
  return session;
}

async function closeSession(accountKey) {
  const session = sessions.get(accountKey);
  sessions.delete(accountKey);
  if (!session) return;
  await session.close().catch(() => undefined);
  log({ event: "session-close", account_key: accountKey });
}

async function brandRulesFor(projectName) {
  if (brandRulesCache.has(projectName)) return brandRulesCache.get(projectName);
  let rules = null;
  try {
    const { brand } = await loadBrandRules(pool, projectName);
    rules = brandRulesFromConfig(brand);
  } catch {
    rules = null;
  }
  brandRulesCache.set(projectName, rules);
  return rules;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 全局并发闸门。ONEGL_ACCOUNT_PARALLELISM 默认 1，也就是同一时间只跑一个账号；
 * 单账号内部由「每个账号一条队列 + concurrency 1」保证串行。
 */
function createSemaphore(permits) {
  let available = permits;
  const waiting = [];

  async function acquire() {
    if (available > 0) {
      available -= 1;
      return;
    }
    await new Promise((resolve) => waiting.push(resolve));
  }

  function release() {
    const next = waiting.shift();
    if (next) next();
    else available += 1;
  }

  return { acquire, release };
}

const gate = createSemaphore(safety.accountParallelism);

async function markSkipped(batchId, reason) {
  await pool.query(
    `UPDATE sampling_batches SET skipped_jobs = skipped_jobs + 1 WHERE id = $1`,
    [batchId],
  );
  log({ event: "job-skipped", batch_id: batchId, reason });
}

async function handleJob(job, token) {
  const { batchId, selectionIndex, accountKey, projectName } = job.data;
  const runToken = runTokenFor(batchId, selectionIndex);
  const runId = runIdFor(batchId, selectionIndex);
  const startedAt = Date.now();
  // BullMQ 的 attemptsMade 是「已经失败过的次数」，所以当前这次是 +1。
  const attempt = job.attemptsMade + 1;

  log({
    event: "job-start",
    batch_id: batchId,
    run_id: runId,
    prompt_id: selectionIndex,
    account_key: accountKey,
    attempt,
  });

  const { rows: batchRows } = await pool.query(
    "SELECT status FROM sampling_batches WHERE id = $1",
    [batchId],
  );
  const batchStatus = batchRows[0]?.status;
  if (!batchStatus) throw new UnrecoverableError(`批次 ${batchId} 不存在`);
  if (batchStatus === "aborted") {
    await markSkipped(batchId, "batch-aborted");
    await refreshBatchProgress(pool, batchId);
    return { skipped: true, reason: "batch-aborted" };
  }

  // 已经成功持久化的分配不再重复执行，队列重试不会产生第二条成功 Run
  const { rows: existing } = await pool.query(
    "SELECT status FROM runs WHERE run_token = $1",
    [runToken],
  );
  if (existing[0] && (existing[0].status === "success" || existing[0].status === "partial")) {
    log({ event: "job-skip", batch_id: batchId, run_id: runId, reason: "already-succeeded" });
    await refreshBatchProgress(pool, batchId);
    return { skipped: true, reason: "already-succeeded" };
  }

  const availability = await accountAvailability(pool, accountKey, safety);
  if (!availability.available) {
    const plan = planUnavailableJob({
      availability,
      cooldownWaits: Number(job.data.cooldownWaits ?? 0),
      maxCooldownWaits: MAX_COOLDOWN_WAITS,
    });

    // 临时状态（冷却 / 频率限制 / 当日额度用完）不能把采样任务永久丢掉：
    // 推迟到恢复时刻再执行，且不消耗重试次数。
    if (plan.action === "delay") {
      await job.updateData({ ...job.data, cooldownWaits: plan.cooldownWaits });
      await job.moveToDelayed(plan.retryAt, token);
      log({
        event: "job-delayed",
        batch_id: batchId,
        run_id: runId,
        account_key: accountKey,
        reason: plan.reason,
        retry_at: new Date(plan.retryAt).toISOString(),
        waits: plan.cooldownWaits,
      });
      // DelayedError 告诉 BullMQ「这不是失败，只是稍后再跑」。
      throw new DelayedError();
    }

    // 永久/人工阻塞（禁用、登录失效、验证码、访问受限、人工暂停），
    // 或等待次数已用完：跳过并停止继续撞击该账号，等人工处理。
    log({
      event: plan.exhausted ? "job-delay-exhausted" : "job-skipped-permanent",
      batch_id: batchId,
      run_id: runId,
      account_key: accountKey,
      reason: plan.reason,
    });
    await markSkipped(batchId, plan.reason);
    await refreshBatchProgress(pool, batchId);
    return { skipped: true, reason: plan.reason };
  }

  await gate.acquire();
  try {
    // 两次提问之间在配置区间内随机等待，避免固定节奏的机械化请求
    await sleep(randomDelayMs(safety));
    await beginAccountRun(pool, accountKey);

    const session = await getSession(accountKey);
    const brandRules = await brandRulesFor(projectName);

    // 关键词正文优先取批次内快照
    const { rows: assignmentRows } = await pool.query(
      `SELECT COALESCE(sbp.prompt_text, p.prompt) AS prompt, sbp.category
         FROM sampling_batch_prompts sbp
         LEFT JOIN prompts p ON p.id = sbp.prompt_id
        WHERE sbp.batch_id = $1 AND sbp.selection_index = $2`,
      [batchId, selectionIndex],
    );
    const promptText = assignmentRows[0]?.prompt;
    if (!promptText) throw new UnrecoverableError(`批次 ${batchId} 缺少分配 ${selectionIndex} 的关键词`);

    const outcome = await runOnePrompt({
      page: session.page,
      store,
      config: loadConfig({ accountKey }),
      prompt: promptText,
      project: projectName,
      pool,
      runId,
      validation: {
        caseId: runToken,
        targetScenario: assignmentRows[0]?.category ?? null,
        tags: assignmentRows[0]?.category ? [assignmentRows[0].category] : [],
      },
      context: {
        accountKey,
        samplingBatchId: batchId,
        brandRules,
        runToken,
        jobId: job.id,
        // 真实重试次数，最终写进 runs.attempt，诊断时才知道这条记录是第几次尝试的结果。
        attempt,
      },
    });

    const code = outcome.normalized?.code ?? null;
    const durationMs = Date.now() - startedAt;

    if (outcome.persistError) {
      // 采集拿到了结果但没写进数据库，属于可重试的情况
      recordAccountFailureSafe(accountKey, code ?? "DATABASE_ERROR");
      await refreshBatchProgress(pool, batchId);
      log({
        event: "job-db-error",
        batch_id: batchId,
        run_id: runId,
        account_key: accountKey,
        error: outcome.persistError.message,
      });
      throw new Error(`数据库写入失败：${outcome.persistError.message}`);
    }

    if (outcome.ok) {
      await recordAccountSuccess(pool, accountKey);
      log({
        event: "job-done",
        batch_id: batchId,
        run_id: runId,
        prompt_id: selectionIndex,
        account_key: accountKey,
        status: outcome.saved.status,
        brand_mentioned: outcome.saved.brandMentioned,
        citations: outcome.saved.citations?.length ?? 0,
        duration_ms: durationMs,
      });
      await refreshBatchProgress(pool, batchId);
      return { status: outcome.saved.status, citations: outcome.saved.citations?.length ?? 0 };
    }

    const failure = await recordAccountFailure(pool, { accountKey, errorCode: code, config: safety });
    if (failure.blocked) {
      log({
        event: "account-blocked",
        account_key: accountKey,
        status: failure.status,
        error_code: code,
      });
    }

    await refreshBatchProgress(pool, batchId);
    log({
      event: "job-failed",
      batch_id: batchId,
      run_id: runId,
      prompt_id: selectionIndex,
      account_key: accountKey,
      status: "failed",
      error_code: code,
      duration_ms: durationMs,
    });

    // 只有明确临时的错误才交给队列重试；账号级阻塞直接判定为不可重试
    if (failure.blocked && ACCOUNT_BLOCKING_CODES[code]) {
      throw new UnrecoverableError(`账号 ${accountKey} 已暂停：${failure.message}`);
    }
    if (!RETRYABLE_CODES.has(code)) {
      throw new UnrecoverableError(`错误 ${code} 不属于可重试类型，已停止重试`);
    }
    throw new Error(`${code}: ${outcome.normalized?.message ?? "未知错误"}`);
  } finally {
    gate.release();
  }
}

function recordAccountFailureSafe(accountKey, errorCode) {
  recordAccountFailure(pool, { accountKey, errorCode, config: safety }).catch(() => undefined);
}

async function startWorkerFor(accountKey) {
  if (workers.has(accountKey) || shuttingDown) return;

  const name = accountQueueName(accountKey);
  // token 必须透传给处理器：moveToDelayed 需要它来把任务挪到冷却结束时刻。
  const worker = new Worker(name, (job, token) => handleJob(job, token), {
    connection: getRedis(),
    // 单账号串行：同一账号任何时刻只允许一个豆包会话任务
    concurrency: WORKER_CONCURRENCY_PER_ACCOUNT,
    lockDuration: 10 * 60 * 1000,
    stalledInterval: 60 * 1000,
  });

  worker.on("failed", async (job, error) => {
    log({
      event: "job-error",
      queue: name,
      job_id: job?.id,
      batch_id: job?.data?.batchId,
      account_key: job?.data?.accountKey,
      attempts: job?.attemptsMade,
      error: error?.message,
    });
    if (job?.data?.batchId) {
      await refreshBatchProgress(pool, job.data.batchId).catch(() => undefined);
    }
  });

  worker.on("error", (error) => {
    console.error(`[worker] 队列错误 ${name}：${error.message}`);
  });

  workers.set(accountKey, worker);
  log({ event: "worker-started", queue: name, account_key: accountKey });
}

async function discoverAccounts() {
  const { rows } = await pool.query(
    `SELECT account_key FROM accounts WHERE enabled = true ORDER BY account_key`,
  );
  for (const row of rows) {
    await startWorkerFor(row.account_key);
  }
  return rows.map((row) => row.account_key);
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log({ event: "shutdown", signal });

  await Promise.all([...workers.values()].map((worker) => worker.close().catch(() => undefined)));
  workers.clear();
  await Promise.all([...sessions.keys()].map((accountKey) => closeSession(accountKey)));
  await pool.end().catch(() => undefined);
  await closeRedis();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function main() {
  const accounts = await discoverAccounts();
  console.log("OneGl 后台采集 Worker 已启动");
  console.log(`  队列前缀      : ${prefix}`);
  console.log(`  监听账号队列  : ${accounts.join(", ") || "（暂无账号）"}`);
  console.log(`  单账号并发    : ${WORKER_CONCURRENCY_PER_ACCOUNT}`);
  console.log(`  账号并行度    : ${safety.accountParallelism}`);
  console.log(
    `  请求间隔      : ${safety.minDelayMs}–${safety.maxDelayMs} ms（随机）`,
  );
  console.log(
    `  账号安全      : 每日上限 ${safety.accountDailyLimit} 次，连续失败 ${safety.maxConsecutiveFailures} 次冷却 ${safety.cooldownMinutes} 分钟`,
  );

  // 新账号在批量入队时才创建，定期扫描以便自动接入
  setInterval(() => {
    discoverAccounts().catch((error) => console.error(`[worker] 扫描账号失败：${error.message}`));
  }, 60_000).unref();
}

main().catch(async (error) => {
  console.error(`Worker 启动失败：${error.message}`);
  await shutdown("startup-error");
});
