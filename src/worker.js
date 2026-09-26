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
  identityPromptsAfterRelaunch,
  promptCountForBatch,
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
import { ErrorCode } from "./errors.js";
import { loadBrandRules } from "./project/init.js";
import { getProviderAdapter, isCredentialFreeSurface, providerBurstPacing } from "./providers/index.js";
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
const ACCOUNT_LOCK_RETRY_MS = Math.max(1_000, Number(process.env.ONEGL_ACCOUNT_LOCK_RETRY_MS) || 15_000);
const SOURCE_INTELLIGENCE_CONCURRENCY = 1;
const SOURCE_INTELLIGENCE_RECONCILE_MS = 15_000;
const SOURCE_INTELLIGENCE_SCRIPT = fileURLToPath(
  new URL("../tools/source-intelligence-capture.js", import.meta.url),
);
// 一个临时冷却的任务最多被推迟几次。冷却本身不消耗重试次数，所以需要一个上限，
// 否则账号长期不可用（例如连续失败一直续冷却）时任务会无限期地挂着。
const MAX_COOLDOWN_WAITS = 3;

// 分轮静置的等待是**计划内**的，不是账号卡住了：匿名通道每轮只给几条，跑满 100 条要等二十
// 多个静置周期，用 3 次的上限会在第三轮就把剩下几十条全部按"长期不可用"跳过。所以它单列一个
// 上限 —— 依然有界（不会无限期挂着），但够跑完一轮完整采集。
const MAX_PACED_WAITS = 120;

// sessions 与 workers 都以 accountIdentity(accountKey, provider) 为键：
// 同一个 account_key 在两个平台下是两份独立登录态，必须各走各的队列与会话。
//
// 会话键还要再带一个槽位后缀（见 sessionKey）：无凭证面允许同一个账号并排跑 N 个浏览器，
// 每个槽位一份独立会话。槽位 0 不加后缀，所以默认配置（slots=1）下的键与改造前逐字相同。
const sessions = new Map();
/**
 * 「这个槽位的会话正在创建中」的 Promise。
 *
 * 存在的唯一理由是防并发建重复浏览器：从「表里没有」到「表里有」之间是 async 的（60~120 秒），
 * 第二个调用必须复用第一次的创建过程，而不是再 launch 一个。详见 getSession。
 */
const sessionCreating = new Map();
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
/**
 * worker 运行时长上限：跑满这么久就主动退出，让容器编排拉起一个全新的进程。
 *
 * 为什么需要（2026-09-26 实测）：同一次长跑（12+ 小时）里反复出现
 * `timeout exceeded when trying to connect`（ioredis 连接超时），而 Redis 侧完全健康 ——
 * rejected_connections=0、内存 4.73M/256M、慢查询最长 11ms。失效发生在 **worker 侧的连接**，
 * 重启就恢复。
 *
 * 但带着失效连接继续跑是有代价的：队列里的任务会一条条耗到 attempts 用尽、被永久判死。
 * 批次 68 因此反复卡在 76/100，而且从 runs 表看只表现为「若干条没有记录」，
 * 极容易被误判成平台问题。
 *
 * 选「按时退出」而不是「检测到异常再退」：前者不依赖探测逻辑恰好命中，
 * 而这类失效本来就是间歇的。退出是安全的 —— compose 里 RestartPolicy=unless-stopped，
 * 容器会被自动拉起。
 */
const MAX_WORKER_UPTIME_MS = (() => {
  const raw = Number(process.env.ONEGL_WORKER_MAX_UPTIME_MS);
  return Number.isInteger(raw) && raw >= 60_000 ? raw : 6 * 60 * 60 * 1000;
})();

async function publishHeartbeat() {
  if (shuttingDown) return;

  // 运行时长自检放在心跳里：它本来就有 10 秒的定时器，不必新开一个生命周期。
  const uptimeMs = Date.now() - workerStartedAt;
  if (uptimeMs > MAX_WORKER_UPTIME_MS) {
    log({
      event: "worker-uptime-limit-reached",
      uptime_ms: uptimeMs,
      limit_ms: MAX_WORKER_UPTIME_MS,
      note: "长跑后 Redis 连接会失效，主动退出让编排拉起新进程，避免任务被耗到 attempts 用尽",
    });
    shuttingDown = true;
    setTimeout(() => process.exit(0), 1_500);
    return;
  }

  try {
    const payload = {
      at: new Date().toISOString(),
      pid: process.pid,
      hostname: os.hostname(),
      startedAt: workerStartedAt,
      accounts: listeningAccounts,
      accountCount: listeningAccounts.length,
      concurrencyPerAccount: safety.accountParallelism,
      // 无凭证面的每账号浏览器数：与上面的凭证侧并发是两个不同的额度，界面要分开显示，
      // 否则运维会以为千问的并发把豆包也放开了。
      accountSlots: safety.accountSlots,
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

/**
 * 会话键：账号身份 + 并发槽位。
 *
 * 槽位 0 刻意不加后缀，这样 ONEGL_ACCOUNT_SLOTS=1（默认）时产生的键与改造前完全一致，
 * 存量部署的行为不会被这次改动碰到。槽位 > 0 才追加 `#<slot>`：`#` 不在 account_key
 * 允许的字符集（[A-Za-z0-9._-]）里，也不在 provider id 里，所以不会与账号名撞车。
 */
function sessionKey(accountKey, provider, slot = 0) {
  const identity = accountIdentity(accountKey, provider);
  const index = Number.isInteger(slot) && slot > 0 ? slot : 0;
  return index > 0 ? `${identity}#${index}` : identity;
}

/**
 * 每个 (平台, 账号, 槽位) 一个浏览器会话，复用以免每次任务都重启一次 Camoufox。
 *
 * 建会话这段必须**串行化**，否则并发调用会各建一个浏览器：
 * `sessions.get` 到 `sessions.set` 之间是 async 的（启动浏览器 + 打开页面要 60~120 秒），
 * 两个调用都会看到「没有会话」、各自 launch 一次，后写的那个覆盖前者 —— 先启动的浏览器
 * 就此**脱离 sessions 管理**，随后被 closeSession/轮换关掉，正在用它的任务报
 * `Target page, context or browser has been closed`（实测 i88/i91 都是这么失败的：
 * 槽位分配是对的，但同一个槽位被并发建了两个浏览器）。
 *
 * 做法是把「正在创建」的 Promise 也放进表里，让第二个调用复用它而不是再建一个。
 */
async function getSession({ accountKey, provider }, slot = 0) {
  const identity = sessionKey(accountKey, provider, slot);

  const existing = await sessions.get(identity);
  if (existing) {
    // 复用前先确认会话还活着。坏掉的会话会让后面每个任务都稳定失败，看起来像
    // 平台在拒绝我们，实际只是浏览器进程已经死了。重建是廉价操作。
    if (existing.isHealthy?.() !== false) return existing;
    log({ event: "session-unhealthy", account_key: accountKey, provider, slot });
    await closeSession({ accountKey, provider }, slot);
  }

  const inflight = sessionCreating.get(identity);
  if (inflight) return inflight;

  const creating = (async () => {
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
      slot: Number.isInteger(slot) && slot > 0 ? slot : undefined,
      stored_auth: session.hasStoredAuth,
    });
    return session;
  })();

  // 放进表里之前先挂上清理：创建失败或完成后都要摘掉，否则一次失败会把这条槽位永久
  // 钉在「正在创建」上，后续任务拿到的都是同一个失败的 Promise。
  // 注意 `creating.finally(...)` 返回的是**新的** Promise，所以不能把结果赋回 creating
  // —— 那会把表中存的变成带清理的那个新 Promise，而它本身也是 rejected 的。
  sessionCreating.set(identity, creating);
  creating
    .catch(() => undefined)
    .finally(() => {
      if (sessionCreating.get(identity) === creating) sessionCreating.delete(identity);
    });
  return creating;
}

/**
 * 按两个独立计数决定这一轮提问前要不要换窗口。
 *
 * 换窗口（default 路径）清的是会话状态：对话历史、页内存储、DOM，新窗口继承账号 cookie，
 * Camoufox 的指纹在 launch 时就定下了，所以平台侧仍是「同一台机器回访」。
 *
 * 换身份（ONEGL_WINDOW_RESET_EVERY）是唯一能改指纹的动作，代价是一次完整冷启动，因此两个
 * 开关分开、各自按自己的计数触发，而不是把两件事绑在一个数字上。作用域由
 * ONEGL_WINDOW_RESET_PROVIDERS 收窄，免得针对一个平台的策略把其它平台的会话也冷启动掉。
 *
 * 三者容易混淆，各自说清：
 *   1. 换窗口读 contextPrompts ——「当前这个窗口服务过几次提问」，rotateContext() 会把它归零。
 *   2. 换身份读**批次内已服务的提问数**（数据库），不是内存计数。内存计数活不过一次进程重启，
 *      而「每 N 条换一次指纹」的节奏必须活得过：重启后若从 0 重数，同一个身份就会连任，
 *      实际周期变成 N+1 条，且这个偏差不报错、只是让指纹与提问的对应关系悄悄漂移。
 *   3. 那条判定放在 `served % every === 0` 这个边界上，所以第 1 组身份服务序号 0、1 两条，
 *      第 2 组服务 2、3 两条……重启后从任意位置接上，落点仍然和没重启过一样。
 *
 * @returns {Promise<object>} 这一轮提问该用的会话 —— 换过身份时是新的那个，否则就是入参本身。
 */
async function prepareWindow(session, account, batchId, slot = 0) {
  const adapter = getProviderAdapter(account.provider);
  const limit = windowPromptLimit(adapter.profile?.quota?.promptsPerWindow, safety.roundPromptLimit);

  const every = safety.windowResetEvery;
  const scoped =
    Array.isArray(safety.windowResetProviders) && safety.windowResetProviders.length > 0
      ? safety.windowResetProviders.includes(String(account.provider).toLowerCase())
      : true;

  if (every > 0 && scoped) {
    // 槽位内的「已服务」计数从数据库推导，且按并发槽位分开：并排跑 N 个浏览器时，每个槽位
    // 有自己的指纹和自己的轮换节奏，用全局批次计数会让 N 个槽位在同一个位置一起重启。
    const served = await promptCountForBatch(pool, {
      batchId,
      accountKey: account.accountKey,
      provider: account.provider,
      slot,
    });
    // 边界判定用 identityPromptsAfterRelaunch 的余数，而不是 shouldRotateIdentity 的
    // `>=` 判定：后者对 4 和 5 都返回 true，会漏掉 5 这个边界（served=5 时余数是 1，
    // 属于第二组身份，不该换）。余数给出的正是「这一格属于哪一组」。
    if (served > 0 && identityPromptsAfterRelaunch(served, every) === 0) {
      const fresh = await relaunchSession(account, slot);
      log({
        event: "fingerprint-rotated",
        account_key: account.accountKey,
        provider: account.provider,
        slot: slot > 0 ? slot : undefined,
        window_reset_every: every,
        prompts_served_before_rotation: served,
      });
      return fresh;
    }
  }

  if (!shouldRotateContext(session.contextPrompts, limit)) return session;
  const accountConfig = loadConfig(account);
  await session.rotateContext();
  await adapter.openPage(session.page, accountConfig);
  log({
    event: "window-rotated",
    account_key: account.accountKey,
    provider: account.provider,
    round_prompt_limit: limit,
  });
  return session;
}

/**
 * 关掉整个浏览器进程并重新冷启动，拿到新的 Camoufox 指纹。
 *
 * 指纹只在 launch_options() 里生成（见 browser.js 的 camoufoxLaunchPayload：os / locale /
 * 屏幕钉死的是**设备类别**，canvas、audio、字体间距这些噪声种子每次启动都重新随机），
 * 所以 rotateContext() 换不掉它，只有重启进程可以。
 *
 * 会话身份不变：新会话仍按同一个 (accountKey, provider) 读同一份登录态，豆包的 cookie
 * 照旧续上，千问那条匿名通道本来就没有凭证。getSession 建会话时计数就是 0，于是
 * ONEGL_WINDOW_RESET_EVERY=N 的语义是「每 N 次提问重启一次」，不是「只跑 N 次」。
 */
async function relaunchSession(account, slot = 0) {
  // closeSession 先摘 sessions map 再关；它建会话时一定写过这条身份。
  await closeSession(account, slot);
  // 关掉旧进程再开新进程：Linux 容器里 browser.close() 之后 camoufox 的 contentproc 树
  // 可能还在收尾（browser.js 按 profile 强杀，grace 3s），抢在它之前冷启动会同时占两个
  // 会话槽位 —— 那个槽位是单线程的，占住就是后续所有会话排队等一个不会 drain 的队列。
  await sleep(1_000);
  // getSession 建完会话就调 adapter.openPage，所以这里不再重复打开页面。
  return getSession(account, slot);
}

async function closeSession({ accountKey, provider }, slot = 0) {
  const identity = sessionKey(accountKey, provider, slot);
  // 先摘掉「创建中」的记录：否则一次 close 之后，仍在进行的创建会把自己写回表里，
  // 让一个已经被关掉的槽位复活成「有会话」。
  sessionCreating.delete(identity);
  const session = sessions.get(identity);
  sessions.delete(identity);
  if (!session) return;
  await session.close().catch(() => undefined);
  log({
    event: "session-close",
    account_key: accountKey,
    provider,
    slot: Number.isInteger(slot) && slot > 0 ? slot : undefined,
  });
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
 *
 * acquire 会把「拿到的是哪一个槽位」一并返回。槽位的意义在无凭证面上才体现出来：同一个账号
 * 并发跑 N 个浏览器时，每个槽位必须绑定**自己的**那份会话（浏览器进程 + 页面 + 指纹），否则
 * 两个任务会共用同一个 page —— 一个在等答案生成，另一个往里塞新提问。
 *
 * 槽位由信号量分配而不是从任务序号推导，正是为了保证「同一时刻一个槽位只属于一个任务」：
 * 空闲槽位排成一个队列，谁先取谁得；释放时若有排队者就**直接把槽位交给它**，不经过中转，
 * 否则会出现「槽位刚被放回、唤醒的等待者却从空集合里取」的竞态。
 */
function createSemaphore(permits) {
  const total = Math.max(1, Math.floor(Number(permits) || 1));
  const free = Array.from({ length: total }, (_, index) => index);
  const waiting = [];

  async function acquire() {
    if (free.length > 0) return free.shift();
    return new Promise((resolve) => waiting.push(resolve));
  }

  function release(slot = null) {
    const next = waiting.shift();
    if (next) {
      next(Number.isInteger(slot) ? slot : 0);
      return;
    }
    if (Number.isInteger(slot) && slot >= 0 && slot < total && !free.includes(slot)) {
      free.push(slot);
      free.sort((a, b) => a - b);
    }
  }

  return { acquire, release, size: total };
}

/**
 * 并发超时的兜底：检测到「平台从未给出答案」的成对超时后，自动把这个账号降到单槽位。
 *
 * 依据是实测（2026-09-24，#66）：并发 2 时 i74/i75 两条**同时** job-start 并同时跑到预算
 * 耗尽（993s / 1015s），而并发下的成功记录耗时稳定在 268s 完全没变。不是本地资源竞争，
 * 是平台对「同一时刻两个匿名请求」的响应被挂起。
 *
 * 判据刻意收紧，避免把平台偶发的慢响应也算进来：
 *   - 只在 slots > 1 时触发（单槽位下没有可降的东西）；
 *   - 只认 TIMEOUT 且 `answerSeen`（超时时已渲染的字符数）极小的超时 —— 有答案说明平台在
 *     慢慢写，那是平台慢，撤并发帮不上忙；
 *   - 同一账号累计到阈值才降，单次不算。
 *
 * 降级是**进程内**的（不落库）：重启后回到配置值。这是有意的 —— 它是一个运行期自我保护，
 * 不是一个需要跨重启延续的状态；而跨重启保留一个静默的降级，反而会让「为什么变慢了」变得难查。
 */
const CONCURRENCY_DEGRADE_WINDOW_MS = 10 * 60_000;
const CONCURRENCY_DEGRADE_THRESHOLD = 2;
const ANSWER_NEVER_RENDERED_CHARS = 50;
/**
 * 降级兜底的开关。
 *
 * 这是个**取舍**，不是纯粹的保护。并发提交被平台惩罚时，降级能立刻止损（不再继续成对超时），
 * 代价是把槽位退回 1、吞吐减半。
 *
 * 实测批次 68：开 2 槽位后 i33–i38 连续六条并发成功，随后 i39/i40 成对超时触发降级，
 * 之后三十多条全部退回单槽位 —— 保护确实生效了，但速度也被它吃掉了，表现为
 * 「配置写的是 2、`take-slot` 却全是 slots=1」，光看配置查不出原因。
 *
 * 所以留一个开关，让运维按当下更在意哪一头来选：
 *   `ONEGL_CONCURRENCY_DEGRADE=0` 关闭 —— 并发不被收回，代价是平台惩罚可能持续。
 */
const CONCURRENCY_DEGRADE_ENABLED = process.env.ONEGL_CONCURRENCY_DEGRADE !== "0";
const degradedAccounts = new Map();
/** 已降级到单槽位的账号身份（accountIdentity 串）。进程内有效。 */
const concurrencyDegraded = new Set();

function noteConcurrencyTimeout(accountKey, provider, slot, errorDetails) {
  if (!CONCURRENCY_DEGRADE_ENABLED) return false;
  if (slotsFor(provider) <= 1) return false;
  const seen = Number(errorDetails?.answerSeen);
  if (!Number.isFinite(seen) || seen > ANSWER_NEVER_RENDERED_CHARS) return false;

  const identity = accountIdentity(accountKey, provider);
  const now = Date.now();
  const recent = (degradedAccounts.get(identity) ?? []).filter((at) => now - at < CONCURRENCY_DEGRADE_WINDOW_MS);
  recent.push(now);
  degradedAccounts.set(identity, recent);

  if (recent.length < CONCURRENCY_DEGRADE_THRESHOLD) {
    log({
      event: "concurrency-timeout-suspected",
      account_key: accountKey,
      provider,
      slot,
      answer_seen: seen,
      recent: recent.length,
    });
    return false;
  }

  concurrencyDegraded.add(identity);
  log({
    event: "concurrency-degraded",
    account_key: accountKey,
    provider,
    slot,
    answer_seen: seen,
    window_ms: CONCURRENCY_DEGRADE_WINDOW_MS,
    from_slots: safety.accountSlots,
    to_slots: 1,
  });
  return true;
}

/**
 * 这个账号可以同时跑几个浏览器。
 *
 * 不分有凭证还是匿名，都由 ONEGL_ACCOUNT_SLOTS 决定；匿名面另有独立的覆盖项
 * （ONEGL_ANONYMOUS_ACCOUNT_SLOTS），因为两面的风险不对称 —— 匿名面多开只多几个同出口 IP
 * 的访客，有凭证的账号多开是拿账号本身去试平台风控。原始设计里只有匿名面能多开
 * （有凭证的账号被账号级 advisory lock 串行化，理由是防止同一登录态被并发击穿）；
 * 现在这个决定交给配置，账号锁在 slots > 1 时按槽位放行，取舍写在 distributed-lock.js。
 *
 * 触发过并发降级的账号返回 1，见 concurrencyDegraded。
 */
function slotsFor(provider, accountKey = null) {
  if (accountKey && concurrencyDegraded.has(accountIdentity(accountKey, provider))) return 1;
  const anonymous = isCredentialFreeSurface(provider);
  const override = safety.anonymousAccountSlots;
  if (anonymous && Number.isInteger(override)) return override;
  return safety.accountSlots;
}

/**
 * 每个账号一个槽位池，而不是所有账号共用一个大池子。
 *
 * 共用池子会让豆包的总并发被千问的槽位数抬高：池子按最大值建，四个豆包账号各自去抢，
 * 抢到的总数就不受 accountParallelism 约束了。按账号分开之后，「几个登录态共享一个额度」
 * 这件事天然成立 —— 凭证侧的并发由账号各自的池子之和决定，而每个池子就是 accountParallelism。
 */
const slotPools = new Map();

function slotPoolFor(accountKey, provider, expectedSlots = null) {
  const identity = accountIdentity(accountKey, provider);
  const want = Number.isInteger(expectedSlots) ? expectedSlots : slotsFor(provider, accountKey);
  let pool = slotPools.get(identity);
  // 池子的容量必须等于当前应有的槽位数，不等就重建：并发降级把 slotsFor 从 N 降到 1 之后，
  // 若继续用旧的 N 容量池子，降级就只停在「函数返回值」上而不会真的限流 —— 那种「配置改了、
  // 行为没变」的情况最难查，因为它每一步看起来都对。
  //
  // 代价是降级瞬间仍在池里等待的任务会随旧池一起被丢弃：它们会 hold 住自己那格，
  // 但 BullMQ 的 lockDuration(10min) 到期后会自动重投，不会永久卡住。
  if (pool && pool.size !== want) {
    log({ event: "slot-pool-resized", account_key: accountKey, provider, from: pool.size, to: want });
    pool = null;
  }
  if (!pool) {
    pool = createSemaphore(want);
    slotPools.set(identity, pool);
  }
  return pool;
}

/**
 * 提交节流：保证同一个账号的两次「提交提问」之间有最小间隔。
 *
 * 与 noteConcurrencyTimeout 的降级兜底是配套的两层 —— 那个是事后止损（已经丢了一条数据才降级），
 * 这个是事前预防（让触发条件根本不出现）。
 *
 * 触发条件是**提交时刻撞车**，不是并发本身：实测两个槽位同时 job-start 会同时跑到预算耗尽，
 * 而单槽位下同样的任务正常完成。本值远小于单条耗时（约 270s），所以错开不会改变吞吐量级，
 * 但能保证任何两个请求不在同一瞬间到达平台。
 *
 * 首条不等待（lastSubmitAt 为空时直接放行）：批次开头那一条没有「上一格」需要错开，
 * 让它白等一个间隔只是降低启动速度。
 */
const submitGates = new Map();

function submitGateFor(accountKey, provider) {
  const identity = accountIdentity(accountKey, provider);
  let state = submitGates.get(identity);
  if (!state) {
    state = { lastSubmitAt: 0, tail: Promise.resolve() };
    submitGates.set(identity, state);
  }
  return state;
}

/** 轮到这个任务提交时，返回还需要等多久（毫秒）。间隔为 0 时恒为 0。 */
async function waitForSubmitSlot(accountKey, provider) {
  const intervalMs = Number(safety.submitIntervalMs ?? 0);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return 0;

  const gate = submitGateFor(accountKey, provider);
  // 串行成队列：并发进来的第二个任务必须等前一个把 lastSubmitAt 更新完才能算自己的时刻，
  // 否则两个任务会读到同一个旧值、算出同一个目标时刻，于是又撞在一起 —— 那样节流就白做了。
  const waitMs = await new Promise((resolve) => {
    gate.tail = gate.tail
      .catch(() => undefined)
      .then(() => {
        const now = Date.now();
        const target = gate.lastSubmitAt ? gate.lastSubmitAt + intervalMs : now;
        const wait = Math.max(0, target - now);
        gate.lastSubmitAt = now + wait;
        resolve(wait);
      });
  });

  if (waitMs > 0) {
    log({
      event: "submit-throttled",
      account_key: accountKey,
      provider,
      wait_ms: waitMs,
      interval_ms: intervalMs,
    });
    await sleep(waitMs);
  }
  return waitMs;
}

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
    // 此刻槽位还没分配（分配发生在账号可用性判定之后），所以这里报的是**当前该账号的并发度**。
    // 真正的槽位号在 take-slot 事件里报 —— 并发下排查「两个任务是否共用了同一个浏览器」时，
    // 那是唯一能把任务与浏览器实例对上的字段：缺了它，日志里只能看到「有会话被开/被关」，
    // 判不出归属（排查 i88 的 `Target page ... has been closed` 时就卡在这一点）。
    slots: slotsFor(provider, accountKey),
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

  // 关键词正文优先取批次内快照。必须在抢账号槽位之前拿到，因为 DB-only replay
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
      maxCooldownWaits: availability.paced ? MAX_PACED_WAITS : MAX_COOLDOWN_WAITS,
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

  // 无凭证面没有可被平台封锁的登录态，账号锁保护不了任何东西；有凭证的账号在 slots > 1 时
  // 也选择让位给吞吐。两种情况由同一个值驱动，具体取舍写在 distributed-lock.js。
  // 并发度求一次、传两处（池子与租约）：两处各自求值的话，一旦其中一处读了降级前的值，
  // 就会出现「池子 1 格、租约按 2 格放行」这种半降级状态。
  const effectiveSlots = slotsFor(provider, accountKey);
  const slotPool = slotPoolFor(accountKey, provider, effectiveSlots);
  const slot = await slotPool.acquire();
  // 拿到槽位就记下来：这是把任务和浏览器实例对上的唯一依据。并发出现
  // 「Target page ... has been closed」这类错误时，第一步就是确认两个并发任务
  // 有没有被分到同一个槽位（那会让它们共用同一个 page）。
  log({
    event: "take-slot",
    batch_id: batchId,
    run_id: runId,
    account_key: accountKey,
    provider,
    slot,
    slots: effectiveSlots,
  });
  const executionLease = await acquireAccountExecutionLease(pool, {
    accountKey,
    provider,
    parallelism: effectiveSlots,
    slot,
  });
  if (!executionLease) {
    // 锁没抢到不是失败，只是稍后再跑。但**必须先把槽位还回去** —— 这条路径是 throw 出去的，
    // 不走下面的 try/finally，槽位留着不还就会一格格漏掉，最后并发度掉到 0，
    // 而且现象是「任务全在排队、进程看着正常、一条也不开始」，很难联想到是这里。
    slotPool.release(slot);
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

  try {
    // 两次提问之间在配置区间内随机等待，避免固定节奏的机械化请求
    await sleep(randomDelayMs(safety));
    await beginAccountRun(pool, accountKey, provider);

    // prepareWindow 换过身份时会返回新的会话（旧浏览器进程已关），必须用它的返回值提问，
    // 否则会拿着一个已经 close 掉的 page 去跑，每个任务都稳定超时。
    const session = await prepareWindow(await getSession(account, slot), account, batchId, slot);
    const brandRules = await brandRulesFor(projectName);

    // 提交节流放在这里、紧邻 runOnePrompt：runOnePrompt 内部就会提交，中间不再有其他等待，
    // 所以这一处的时刻就代表真实的提交时刻（详见 waitForSubmitSlot）。
    await waitForSubmitSlot(accountKey, provider);

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
        // 落在 runs.request_slot：指纹轮换的计数按槽位分开算，见 migrations/0028。
        requestSlot: slot,
      },
    });
    // 计的是「这个窗口服务过几次提问」，与成功/失败无关：一个卡住的窗口不该因为
    // 失败就一直续命。注意这与身份轮换读的那个计数**不是**同一个：轮换用的是批次内已服务
    // 提问数（数据库，见 prepareWindow），这个只是当前窗口的计数，rotateContext() 会清零。
    session.contextPrompts += 1;
    session.sessionPrompts = (session.sessionPrompts ?? 0) + 1;

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
    // 并发超时的兜底：只有 TIMEOUT 且「平台整段预算内一个字符都没给出」才计入，
    // 累计到阈值就把这个账号降到单槽位。详见 noteConcurrencyTimeout 的注释。
    if (code === ErrorCode.TIMEOUT) {
      noteConcurrencyTimeout(accountKey, provider, slot, outcome.normalized?.details ?? null);
    }
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
    slotPool.release(slot);
    await executionLease.release();
  }
}

/**
 * 基础设施类失败：与平台无关，提问也从未送出，所以**可以安全再给一次机会**。
 *
 * 为什么单独处理这一类：`timeout exceeded when trying to connect` 是 ioredis 抛的，
 * 说明任务连 Redis 都没连上、采集根本没开始。它不走 `handleJob` 的
 * `canRetryOutcome` 那条路（那时处理器都没被调用），而是直接落到 BullMQ 的
 * `failed` 事件上；于是它既拿不到「未提交」的证据，也无法通过错误码判可重试 ——
 * 只会一路耗到 attempts 用尽，被永久判死在 failed 集合里。
 *
 * 实测代价：批次 68 有 15 条卡在这上面，批次因此停在 84/100 再也跑不动，
 * 而从 runs 表看只是「没有记录」，非常容易误判成平台问题。
 *
 * 只给一次额外机会：基础设施持续故障时无限重试会把队列变成忙循环，
 * 而重试本身也救不了已经宕掉的 Redis。
 */
const INFRA_FAILURE_PATTERN = /timeout exceeded when trying to connect|ECONNRESET|Connection is closed|EPIPE/i;
const INFRA_RETRY_LIMIT = 1;
const infraRetried = new Map();

function isInfrastructureFailure(error) {
  return INFRA_FAILURE_PATTERN.test(String(error?.message ?? ""));
}

async function startWorkerFor(accountKey, provider = "doubao") {
  const identity = accountIdentity(accountKey, provider);
  if (workers.has(identity) || shuttingDown) return;

  const name = accountQueueName(accountKey, provider);
  // token 必须透传给处理器：moveToDelayed 需要它来把任务挪到冷却结束时刻。
  const worker = new Worker(name, (job, token) => handleJob(job, token), {
    connection: getRedis(),
    // BullMQ 的 concurrency 只约束当前 Worker 实例；跨进程互斥由数据库租约保证。
    // 取这个账号自己的槽位数：无凭证面允许多个浏览器并排（实际的槽位隔离在 handleJob 里），
    // 有凭证面则为 accountParallelism。
    concurrency: slotsFor(provider),
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

    // 基础设施失败先给一次额外机会再算失败：它和平台无关、提问也从未送出。
    // 放在 refreshBatchProgress 之前 return —— 这一轮并没有真正产生结果，
    // 不该按「一条跑完了」去推进批次进度。
    if (job && isInfrastructureFailure(error)) {
      const already = infraRetried.get(job.id) ?? 0;
      if (already < INFRA_RETRY_LIMIT) {
        infraRetried.set(job.id, already + 1);
        log({
          event: "job-infra-retry",
          queue: name,
          job_id: job?.id,
          batch_id: job?.data?.batchId,
          run_id: job?.data?.runId,
          retry_no: already + 1,
          error: error?.message,
        });
        await job.retry().catch((retryError) => {
          console.error(`[worker] 基础设施失败补跑未成功 ${job?.id}：${retryError?.message}`);
        });
        return;
      }
      log({
        event: "job-infra-retry-exhausted",
        queue: name,
        job_id: job?.id,
        batch_id: job?.data?.batchId,
        retry_no: already,
      });
    }

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
  console.log(`  单账号并发    : ${safety.accountParallelism}（有凭证账号，跨进程数据库锁）`);
  console.log(`  匿名账号槽位  : ${safety.accountSlots}（无凭证面，每槽位独立浏览器与指纹）`);
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
