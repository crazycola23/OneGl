import "dotenv/config";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DelayedError, UnrecoverableError, Worker } from "bullmq";
import { acquireAccountExecutionLease } from "./accounts/distributed-lock.js";
import {
  ACCOUNT_BLOCKING_CODES,
  accountAvailability,
  canRetryOutcome,
  beginAccountRun,
  markStorageStatePresent,
  randomDelayMs,
  recordAccountFailure,
  recordAccountSuccess,
  safetyConfig,
  shouldRotateContext,
  windowPromptLimit,
} from "./accounts/safety.js";
import { reclaimStaleAccountWorkers } from "./accounts/worker-reconcile.js";
import { launchBrowserSession } from "./browser.js";
import {
  brandRulesFromConfig,
  replayPendingPersistence,
  runOnePrompt,
} from "./collect/runner.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { loadBrandRules } from "./project/init.js";
import { getProviderAdapter, providerBurstPacing } from "./providers/index.js";
import {
  accountIdentity,
  accountQueueName,
  closeRedis,
  getRedis,
  isQueueConfigured,
  parseAccountIdentity,
  sourceIntelligenceQueueName,
} from "./queue/connection.js";
import { refreshBatchProgress, runIdFor, runTokenFor } from "./queue/batches.js";
import { planUnavailableJob } from "./queue/job-plan.js";
import {
  finishSourceIntelligence,
  markSourceIntelligenceRunning,
  reconcileSourceIntelligence,
  sourceIntelligenceCoverage,
} from "./queue/source-intelligence.js";
import {
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_TTL_SECONDS,
  workerHeartbeatKey,
} from "./system/status.js";
import { RunStore } from "./store.js";

/**
 * 后台采集 Worker。
 *
 * 独立的进程，与 Web 进程互不影响：Web 只负责入队和展示，真正的
 * Camoufox / Playwright 长任务全部在这里执行。
 *
 * 采集逻辑直接复用 src/collect/runner.js（与命令行同一份内核），
 * 没有第二套登录判断、提问、回答与引用提取实现。
 *
 * 引用页内容情报走另一条 BullMQ 队列，并在独立 Node 子进程里执行，
 * 不占账号采集队列、不读取登录态，也不会把第三方页面失败改写成批次失败。
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
const ACCOUNT_LOCK_RETRY_MS = Math.max(1_000, Number(process.env.ONEGL_ACCOUNT_LOCK_RETRY_MS) || 15_000);
const SOURCE_INTELLIGENCE_CONCURRENCY = 1;
const SOURCE_INTELLIGENCE_RECONCILE_MS = 15_000;
const SOURCE_INTELLIGENCE_SCRIPT = fileURLToPath(
  new URL("../tools/source-intelligence-capture.js", import.meta.url),
);
// 一个临时冷却的任务最多被推迟几次。冷却本身不消耗重试次数，所以需要一个上限，
// 否则账号长期不可用（例如连续失败一直续冷却）时任务会无限期地挂着。
const MAX_COOLDOWN_WAITS = 3;

// sessions 与 workers 都以 accountIdentity(accountKey, provider) 为键：
// 同一个 account_key 在两个平台下是两份独立登录态，必须各走各的队列与会话。
const sessions = new Map();
const brandRulesCache = new Map();
const workers = new Map();
let sourceIntelligenceWorker = null;
let shuttingDown = false;

function log(fields) {
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${value}`);
  console.log(`[worker] ${parts.join(" ")}`);
}

/* ------------------------------------------------------------------ 心跳 */

const workerStartedAt = new Date().toISOString();
let listeningAccounts = [];

/**
 * Web 端靠这个键判断 Worker 是否在线 —— Redis 在线不等于 Worker 在线。
 *
 * 只写派生状态：进程号、主机名、启动时间、监听的账号列表。
 * 绝不写入 Cookie、storageState、session token 或任何凭据。
 *
 * 键带 TTL：Worker 崩溃后会自动过期，不会留下一个「假装在线」的心跳。
 */
async function publishHeartbeat() {
  if (shuttingDown) return;
  try {
    const payload = {
      at: new Date().toISOString(),
      pid: process.pid,
      hostname: os.hostname(),
      startedAt: workerStartedAt,
      accounts: listeningAccounts,
      accountCount: listeningAccounts.length,
      concurrencyPerAccount: WORKER_CONCURRENCY_PER_ACCOUNT,
      accountParallelism: safety.accountParallelism,
      distributedExecutionLease: true,
      sourceIntelligence: {
        queue: sourceIntelligenceQueueName(),
        concurrency: SOURCE_INTELLIGENCE_CONCURRENCY,
        online: sourceIntelligenceWorker !== null,
      },
    };
    await getRedis().set(
      workerHeartbeatKey(),
      JSON.stringify(payload),
      "EX",
      WORKER_HEARTBEAT_TTL_SECONDS,
    );
  } catch (error) {
    // 心跳失败不能影响采集本身，下一轮会重试。
  }
}

/** 每个 (平台, 账号) 一个浏览器会话，复用以免每次任务都重启一次 Camoufox。 */
async function getSession({ accountKey, provider }) {
  const identity = accountIdentity(accountKey, provider);
  const existing = sessions.get(identity);
  if (existing) {
    // 复用前先确认会话还活着。坏掉的会话会让后面每个任务都稳定失败，看起来像
    // 平台在拒绝我们，实际只是浏览器进程已经死了。重建是廉价操作。
    if (existing.isHealthy?.() !== false) return existing;
    log({ event: "session-unhealthy", account_key: accountKey, provider });
    await closeSession({ accountKey, provider });
  }

  const accountConfig = loadConfig({ accountKey, provider });
  const adapter = getProviderAdapter(provider);
  const session = await launchBrowserSession(accountConfig);
  await adapter.openPage(session.page, accountConfig);
  // 匿名面没有登录态可标记，写进去会让运营以为这个身份已经绑定成功。
  if (adapter.requiresStoredAuth !== false) {
    await markStorageStatePresent(pool, accountKey, session.hasStoredAuth, provider).catch(() => undefined);
  }

  sessions.set(identity, session);
  log({
    event: "session-open",
    account_key: accountKey,
    provider,
    stored_auth: session.hasStoredAuth,
  });
  return session;
}

/**
 * 每问满 ONEGL_ROUND_PROMPT_LIMIT 次就关掉当前窗口、换一个干净窗口。
 *
 * 换的是会话状态（对话历史、页内存储、DOM），不是设备身份：新窗口继承账号 cookie，
 * Camoufox 的指纹也在 launch 时就定下了，所以平台侧仍是「同一台机器回访」，而高频
 * 重启 Camoufox 反而会去踩 browser.js 里那棵孤儿进程树的坑。
 */
async function prepareWindow(session, account) {
  const adapter = getProviderAdapter(account.provider);
  const limit = windowPromptLimit(adapter.profile?.quota?.promptsPerWindow, safety.roundPromptLimit);
  if (!shouldRotateContext(session.contextPrompts, limit)) return;
  const accountConfig = loadConfig(account);
  await session.rotateContext();
  await adapter.openPage(session.page, accountConfig);
  log({
    event: "window-rotated",
    account_key: account.accountKey,
    provider: account.provider,
    round_prompt_limit: limit,
  });
}

async function closeSession({ accountKey, provider }) {
  const identity = accountIdentity(accountKey, provider);
  const session = sessions.get(identity);
  sessions.delete(identity);
  if (!session) return;
  await session.close().catch(() => undefined);
  log({ event: "session-close", account_key: accountKey, provider });
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
 * 进程内闸门仍保留作为第二层保护；真正跨 Worker 进程的账号互斥与全局并行度
 * 由 PostgreSQL advisory lock 保证。
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
  const provider = job.data.provider ?? "doubao";
  const account = { accountKey, provider };
  // 平台必须已注册 adapter。否则浏览器会话会打开豆包的登录面、却把结果存进另一个
  // 平台的登录态里，所以要在任何设备动作之前拦下来。
  try {
    getProviderAdapter(provider);
  } catch {
    throw new UnrecoverableError(`平台 ${provider} 没有已注册的 adapter，已跳过任务`);
  }
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
    provider,
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

  // 关键词正文优先取批次内快照。必须在账号 gate 之前拿到，因为 DB-only replay
  // 需要用同一份 prompt identity 验证本地证据，但绝不能因此启动浏览器或消耗配额。
  const { rows: assignmentRows } = await pool.query(
    `SELECT COALESCE(sbp.prompt_text, p.prompt) AS prompt, sbp.category, p.external_id AS prompt_external_id
       FROM sampling_batch_prompts sbp
       LEFT JOIN prompts p ON p.id = sbp.prompt_id
      WHERE sbp.batch_id = $1 AND sbp.selection_index = $2`,
    [batchId, selectionIndex],
  );
  const promptText = assignmentRows[0]?.prompt;
  if (!promptText) throw new UnrecoverableError(`批次 ${batchId} 缺少分配 ${selectionIndex} 的关键词`);
  // The prompt's own identity, not this run's. Passing the run token here made persistence insert a
  // *new* prompt row for a text that already existed (the upsert keys on text + external_id), so
  // every collected run enlarged the pool and the next execution sampled the bigger pool.
  const validation = {
    caseId: assignmentRows[0]?.prompt_external_id ?? null,
    targetScenario: assignmentRows[0]?.category ?? null,
    tags: assignmentRows[0]?.category ? [assignmentRows[0].category] : [],
  };

  // Persistence recovery is infrastructure work, not provider work. It runs before
  // account availability, distributed leases, random delay, daily quota accounting and
  // browser startup. The dedicated helper can never fall through to provider collection.
  const replay = await replayPendingPersistence({
    store,
    pool,
    runId,
    prompt: promptText,
    project: projectName,
    validation,
    context: {
      accountKey,
      samplingBatchId: batchId,
      runToken,
      jobId: job.id,
      attempt,
    },
  });
  if (replay) {
    await refreshBatchProgress(pool, batchId);
    if (replay.persistError) {
      log({
        event: "job-db-replay-error",
        batch_id: batchId,
        run_id: runId,
        account_key: accountKey,
        error: replay.persistError.message,
      });
      throw new Error(`数据库重放失败：${replay.persistError.message}`);
    }
    log({
      event: "job-persistence-replayed",
      batch_id: batchId,
      run_id: runId,
      account_key: accountKey,
      status: replay.saved.status,
    });
    return {
      status: replay.saved.status,
      citations: replay.saved.citations?.length ?? 0,
      persistenceReplay: true,
    };
  }

  const availability = await accountAvailability(pool, accountKey, safety, provider, providerBurstPacing(provider));
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

  const executionLease = await acquireAccountExecutionLease(pool, {
    accountKey,
    provider,
    parallelism: safety.accountParallelism,
  });
  if (!executionLease) {
    const retryAt = Date.now() + ACCOUNT_LOCK_RETRY_MS;
    await job.moveToDelayed(retryAt, token);
    log({
      event: "job-delayed-distributed-lock",
      batch_id: batchId,
      run_id: runId,
      account_key: accountKey,
      retry_at: new Date(retryAt).toISOString(),
    });
    throw new DelayedError();
  }

  await gate.acquire();
  try {
    // 两次提问之间在配置区间内随机等待，避免固定节奏的机械化请求
    await sleep(randomDelayMs(safety));
    await beginAccountRun(pool, accountKey, provider);

    const session = await getSession(account);
    await prepareWindow(session, account);
    const brandRules = await brandRulesFor(projectName);

    const outcome = await runOnePrompt({
      page: session.page,
      store,
      config: loadConfig(account),
      prompt: promptText,
      project: projectName,
      pool,
      runId,
      validation,
      context: {
        accountKey,
        provider,
        samplingBatchId: batchId,
        brandRules,
        runToken,
        jobId: job.id,
        // 真实重试次数，最终写进 runs.attempt，诊断时才知道这条记录是第几次尝试的结果。
        attempt,
      },
    });
    // 计的是「这个窗口服务过几次提问」，与成功/失败无关：一个卡住的窗口不该因为
    // 失败就一直续命。
    session.contextPrompts += 1;

    const code = outcome.normalized?.code ?? null;
    const durationMs = Date.now() - startedAt;

    if (outcome.persistError) {
      // Provider collection succeeded but OneGl infrastructure did not. Preserve provider
      // health as successful, then let BullMQ retry only the immutable persistence replay.
      if (outcome.ok) await recordAccountSuccess(pool, accountKey, provider).catch(() => undefined);
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
      await recordAccountSuccess(pool, accountKey, provider);
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

    const failure = await recordAccountFailure(pool, { accountKey, provider, errorCode: code, config: safety });
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
    // 重试前必须确认上一次提问没有送到平台。否则「重试」等于再发一次同样的提问，
    // 既污染样本，也正是平台最容易识别为滥用的行为。
    if (!canRetryOutcome(code, outcome.normalized?.details)) {
      const submitted = outcome.normalized?.details?.promptSubmitted;
      const reason =
        submitted === true || submitted === undefined
          ? "上次提问可能已经提交，重试会造成重复提问"
          : `错误 ${code} 不属于可重试类型`;
      log({
        event: "job-no-retry",
        batch_id: batchId,
        run_id: runId,
        account_key: accountKey,
        error_code: code,
        prompt_submitted: submitted ?? null,
      });
      throw new UnrecoverableError(`${reason}，已停止重试`);
    }
    throw new Error(`${code}: ${outcome.normalized?.message ?? "未知错误"}`);
  } finally {
    gate.release();
    await executionLease.release();
  }
}

async function startWorkerFor(accountKey, provider = "doubao") {
  const identity = accountIdentity(accountKey, provider);
  if (workers.has(identity) || shuttingDown) return;

  const name = accountQueueName(accountKey, provider);
  // token 必须透传给处理器：moveToDelayed 需要它来把任务挪到冷却结束时刻。
  const worker = new Worker(name, (job, token) => handleJob(job, token), {
    connection: getRedis(),
    // BullMQ 的 concurrency=1 只约束当前 Worker 实例；跨进程互斥由数据库租约保证。
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

  workers.set(identity, worker);
  log({ event: "worker-started", queue: name, account_key: accountKey, provider });
}

/** 与 startWorkerFor 对称：软删的账号必须能下线，否则常驻 worker 会带着已回收的登录态继续采集。 */
async function stopWorkerFor(identity) {
  const worker = workers.get(identity);
  if (!worker) return;
  const { accountKey, provider } = parseAccountIdentity(identity);
  // 先摘 map 再 close：close 要等在跑的任务收尾，期间这个 key 不该被重复停止或重新启动。
  workers.delete(identity);
  await worker.close().catch(() => undefined);
  await closeSession({ accountKey, provider });
  // Redis 队列 onegl-run-<platform>-<key> 有意保留：删它等于丢弃未完成任务，需要单独的操作窗口。
  log({
    event: "worker-stopped",
    queue: accountQueueName(accountKey, provider),
    account_key: accountKey,
    provider,
  });
}

function runSourceIntelligenceChild(batchId) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [SOURCE_INTELLIGENCE_SCRIPT, "--batch", String(batchId), "--refresh"],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderrTail = "";
    child.stdout.on("data", (chunk) => {
      process.stdout.write(`[source-intelligence] ${chunk}`);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderrTail = `${stderrTail}${text}`.slice(-12_000);
      process.stderr.write(`[source-intelligence] ${text}`);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) return resolve({ code: 0, signal: signal ?? null });
      const suffix = stderrTail.trim() ? `：${stderrTail.trim().slice(-2000)}` : "";
      reject(new Error(`引用页分析子进程退出 code=${code} signal=${signal ?? "none"}${suffix}`));
    });
  });
}

async function handleSourceIntelligenceJob(job) {
  const batchId = Number(job.data?.batchId);
  const generation = Number(job.data?.generation);
  const batchFinishedAt = job.data?.batchFinishedAt ? String(job.data.batchFinishedAt) : null;
  if (
    !Number.isInteger(batchId) ||
    batchId <= 0 ||
    !Number.isInteger(generation) ||
    !batchFinishedAt ||
    !Number.isFinite(Date.parse(batchFinishedAt))
  ) {
    throw new UnrecoverableError("引用页分析任务缺少有效 batchId / generation / batchFinishedAt");
  }

  const accepted = await markSourceIntelligenceRunning(
    pool,
    batchId,
    generation,
    batchFinishedAt,
  );
  if (!accepted) {
    log({
      event: "source-intelligence-superseded",
      batch_id: batchId,
      generation,
    });
    return { superseded: true };
  }

  log({ event: "source-intelligence-start", batch_id: batchId, generation });
  await runSourceIntelligenceChild(batchId);

  const coverage = await sourceIntelligenceCoverage(pool, batchId);
  let status = "completed";
  let error = null;
  if (coverage.citedSources > 0 && coverage.analyzedSources === 0) {
    status = "failed";
    error = `0/${coverage.citedSources} 个用户可见引用页完成内容分析`;
  } else if (coverage.analyzedSources < coverage.citedSources) {
    status = "partial";
    error = `${coverage.unresolvedSources} 个用户可见引用页未完成分析`;
  }

  const saved = await finishSourceIntelligence(pool, batchId, generation, {
    status,
    error,
    batchFinishedAt,
  });
  if (!saved) return { superseded: true, coverage };

  log({
    event: "source-intelligence-done",
    batch_id: batchId,
    generation,
    status,
    cited_sources: coverage.citedSources,
    analyzed_sources: coverage.analyzedSources,
    brand_evidence_sources: coverage.brandEvidenceSources,
  });
  return { status, coverage };
}

async function startSourceIntelligenceWorker() {
  if (sourceIntelligenceWorker || shuttingDown) return sourceIntelligenceWorker;
  const name = sourceIntelligenceQueueName();
  const worker = new Worker(name, handleSourceIntelligenceJob, {
    connection: getRedis(),
    concurrency: SOURCE_INTELLIGENCE_CONCURRENCY,
    lockDuration: 30 * 60 * 1000,
    stalledInterval: 60 * 1000,
  });

  worker.on("failed", async (job, error) => {
    log({
      event: "source-intelligence-error",
      queue: name,
      job_id: job?.id,
      batch_id: job?.data?.batchId,
      generation: job?.data?.generation,
      attempts: job?.attemptsMade,
      error: error?.message,
    });
    const attempts = Number(job?.opts?.attempts ?? 1);
    if (job && Number(job.attemptsMade ?? 0) >= attempts) {
      await finishSourceIntelligence(pool, Number(job.data.batchId), Number(job.data.generation), {
        status: "failed",
        error: error?.message ?? "引用页分析任务失败",
        batchFinishedAt: job.data?.batchFinishedAt ? String(job.data.batchFinishedAt) : null,
      }).catch(() => undefined);
    }
  });

  worker.on("error", (error) => {
    console.error(`[worker] 引用页分析队列错误 ${name}：${error.message}`);
  });

  sourceIntelligenceWorker = worker;
  log({ event: "worker-started", queue: name, concurrency: SOURCE_INTELLIGENCE_CONCURRENCY });
  return worker;
}

async function reconcileIntelligence() {
  if (shuttingDown) return [];
  return reconcileSourceIntelligence(pool, {
    limit: 20,
    log: (message) => log({ event: "source-intelligence-schedule", message }),
  });
}

async function discoverAccounts() {
  const { rows } = await pool.query(
    `SELECT account_key, provider FROM accounts WHERE enabled = true ORDER BY provider, account_key`,
  );
  for (const row of rows) {
    await startWorkerFor(row.account_key, row.provider);
  }
  listeningAccounts = rows.map((row) => accountIdentity(row.account_key, row.provider));
  // 停线放在 listeningAccounts 刷新之后：心跳立刻反映账号已下线，慢 close 也不拖住新账号接入。
  const stopped = await reclaimStaleAccountWorkers(workers.keys(), listeningAccounts, stopWorkerFor);
  if (stopped.length) log({ event: "accounts-reclaimed", account_keys: stopped.join(",") });
  return listeningAccounts;
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log({ event: "shutdown", signal });

  await Promise.all([...workers.values()].map((worker) => worker.close().catch(() => undefined)));
  workers.clear();
  if (sourceIntelligenceWorker) {
    const worker = sourceIntelligenceWorker;
    sourceIntelligenceWorker = null;
    await worker.close().catch(() => undefined);
  }
  await Promise.all(
    [...sessions.keys()].map((identity) => closeSession(parseAccountIdentity(identity))),
  );
  await pool.end().catch(() => undefined);
  // 主动删掉心跳，界面立刻就能反映「Worker 已停止」，不用等 TTL 过期。
  await getRedis()
    .del(workerHeartbeatKey())
    .catch(() => undefined);
  await closeRedis();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function main() {
  await startSourceIntelligenceWorker();
  const accounts = await discoverAccounts();
  console.log("OneGl 后台采集 Worker 已启动");
  console.log(`  队列前缀      : ${prefix}`);
  console.log(`  监听账号队列  : ${accounts.join(", ") || "（暂无账号）"}`);
  console.log(`  单账号并发    : ${WORKER_CONCURRENCY_PER_ACCOUNT}（跨进程数据库锁）`);
  console.log(`  账号并行度    : ${safety.accountParallelism}（跨进程全局 slot）`);
  console.log(`  引用页分析    : ${sourceIntelligenceQueueName()}（并发 ${SOURCE_INTELLIGENCE_CONCURRENCY}）`);
  console.log(
    `  请求间隔      : ${safety.minDelayMs}–${safety.maxDelayMs} ms（随机）`,
  );
  console.log(
    `  账号安全      : 每日上限 ${safety.accountDailyLimit} 次，连续失败 ${safety.maxConsecutiveFailures} 次冷却 ${safety.cooldownMinutes} 分钟`,
  );
  console.log(`  心跳          : ${workerHeartbeatKey()}（每 ${WORKER_HEARTBEAT_INTERVAL_MS / 1000} 秒）`);

  // Worker 启动后先补历史/刚完成的批次，再进入周期对账。
  await reconcileIntelligence().catch((error) => {
    console.error(`[worker] 引用页分析初始对账失败：${error.message}`);
  });

  // Web 端靠心跳判断 Worker 是否在线；Redis 在线不代表 Worker 在线。
  await publishHeartbeat();
  setInterval(() => {
    publishHeartbeat().catch(() => undefined);
  }, WORKER_HEARTBEAT_INTERVAL_MS).unref();

  setInterval(() => {
    reconcileIntelligence().catch((error) =>
      console.error(`[worker] 引用页分析对账失败：${error.message}`),
    );
  }, SOURCE_INTELLIGENCE_RECONCILE_MS).unref();

  // 新账号在批量入队时才创建，定期扫描以便自动接入
  setInterval(() => {
    discoverAccounts().catch((error) => console.error(`[worker] 扫描账号失败：${error.message}`));
  }, 60_000).unref();
}

main().catch(async (error) => {
  console.error(`Worker 启动失败：${error.message}`);
  await shutdown("startup-error");
});
