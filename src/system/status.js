import os from "node:os";

import { databaseReady } from "../db/dashboard.js";
import { isDatabaseConfigured } from "../db/pool.js";
import { getRedis, isQueueConfigured, queuePrefix } from "../queue/connection.js";

/**
 * 操作台的系统就绪状态。
 *
 * 目的只有一个：回答「我现在点开始监测，到底能不能跑」。
 *
 * 三类判断依据：
 *   PostgreSQL  真实查询（SELECT 1），不只看 DATABASE_URL 是否存在
 *   Redis       真实 PING，区分「没配置」和「配了但连不上」
 *   Worker      Redis 上的一个临时心跳键，因为 Redis 在线不代表 Worker 在线
 *
 * 心跳只存派生状态，不含 Cookie、session、token 或任何凭据。
 */

export const WORKER_HEARTBEAT_ONLINE_MS = 30_000;
export const WORKER_HEARTBEAT_DEGRADED_MS = 90_000;
/** 心跳键的 TTL 取得比 degraded 阈值更长，这样 Worker 崩溃后键会自然过期。 */
export const WORKER_HEARTBEAT_TTL_SECONDS = 120;
export const WORKER_HEARTBEAT_INTERVAL_MS = 10_000;

export function workerHeartbeatKey(prefix = queuePrefix()) {
  return `${prefix}:worker:heartbeat`;
}

export const CONNECTION_STATES = Object.freeze({
  CONNECTED: "connected",
  UNREACHABLE: "unreachable",
  NOT_CONFIGURED: "not_configured",
});

export const WORKER_STATES = Object.freeze({
  ONLINE: "online",
  DEGRADED: "degraded",
  OFFLINE: "offline",
  UNKNOWN: "unknown",
});

/** 纯逻辑：根据心跳时间判断 Worker 是否在线。 */
export function classifyWorkerHeartbeat(heartbeat, now = Date.now()) {
  if (!heartbeat) return { state: WORKER_STATES.OFFLINE, ageMs: null };
  const at = Date.parse(heartbeat.at ?? "");
  if (Number.isNaN(at)) return { state: WORKER_STATES.OFFLINE, ageMs: null };

  const ageMs = Math.max(0, now - at);
  if (ageMs <= WORKER_HEARTBEAT_ONLINE_MS) return { state: WORKER_STATES.ONLINE, ageMs };
  if (ageMs <= WORKER_HEARTBEAT_DEGRADED_MS) return { state: WORKER_STATES.DEGRADED, ageMs };
  return { state: WORKER_STATES.OFFLINE, ageMs };
}

export async function probeDatabase(pool) {
  if (!pool || !isDatabaseConfigured()) {
    return { state: CONNECTION_STATES.NOT_CONFIGURED, message: "未配置 DATABASE_URL" };
  }
  const result = await databaseReady(pool);
  return result.ready
    ? { state: CONNECTION_STATES.CONNECTED, message: "" }
    : { state: CONNECTION_STATES.UNREACHABLE, message: result.message };
}

/** Redis 必须真实 PING：REDIS_URL 存在不代表 Redis 活着。 */
export async function probeRedis() {
  if (!isQueueConfigured()) {
    return { state: CONNECTION_STATES.NOT_CONFIGURED, message: "未配置 REDIS_URL" };
  }
  try {
    const connection = getRedis();
    const started = Date.now();
    const pong = await connection.ping();
    if (pong !== "PONG") {
      return { state: CONNECTION_STATES.UNREACHABLE, message: `PING 返回 ${pong}` };
    }
    return { state: CONNECTION_STATES.CONNECTED, message: "", latencyMs: Date.now() - started };
  } catch (error) {
    return {
      state: CONNECTION_STATES.UNREACHABLE,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function readWorkerHeartbeat() {
  if (!isQueueConfigured()) return null;
  try {
    const raw = await getRedis().get(workerHeartbeatKey());
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ 账号分组 */

export const ACCOUNT_GROUPS = Object.freeze({
  HEALTHY: "healthy",
  AUTO_WAITING: "auto_waiting",
  MANUAL_ATTENTION: "manual_attention",
  DISABLED: "disabled",
});

export const ACCOUNT_GROUP_LABELS = Object.freeze({
  healthy: "正常",
  auto_waiting: "自动等待",
  manual_attention: "需要人工处理",
  disabled: "已禁用",
});

/** 账号状态的中文标签与色调，界面与文案共用一份定义。 */
export const ACCOUNT_STATUS_LABELS = Object.freeze({
  unknown: "未知",
  healthy: "正常",
  cooldown: "冷却中",
  paused: "已暂停",
  disabled: "已禁用",
  login_required: "需要登录",
  session_expired: "登录态失效",
  verification_required: "需要人工验证",
  access_restricted: "访问受限",
  rate_limited: "触发频率限制",
});

export const ACCOUNT_STATUS_TONES = Object.freeze({
  healthy: "ok",
  cooldown: "warn",
  rate_limited: "warn",
  paused: "warn",
  disabled: "muted",
  unknown: "muted",
  login_required: "bad",
  session_expired: "bad",
  verification_required: "bad",
  access_restricted: "bad",
});

/** 只有这些状态才真的需要人工介入；冷却不属于其中之一。 */
const MANUAL_ATTENTION_STATUSES = new Set([
  "login_required",
  "session_expired",
  "verification_required",
  "access_restricted",
  "paused",
]);

const AUTO_WAITING_STATUSES = new Set(["cooldown", "rate_limited"]);

/**
 * 纯逻辑：把一个账号归入操作员视角的四个分组之一。
 *
 * cooldown / rate_limited / 当日额度用完都只是「等一会儿自己会好」，
 * 与「需要你去重新登录」是性质完全不同的两件事，界面不能混为一谈。
 */
export function accountGroupOf(account, { dailyLimit = 60 } = {}) {
  if (!account) return ACCOUNT_GROUPS.DISABLED;
  if (!account.enabled) return ACCOUNT_GROUPS.DISABLED;

  const status = account.status ?? "unknown";
  if (MANUAL_ATTENTION_STATUSES.has(status)) return ACCOUNT_GROUPS.MANUAL_ATTENTION;
  if (AUTO_WAITING_STATUSES.has(status)) return ACCOUNT_GROUPS.AUTO_WAITING;

  const cooldownUntil = account.cooldown_until ? new Date(account.cooldown_until) : null;
  if (cooldownUntil && cooldownUntil.getTime() > Date.now()) return ACCOUNT_GROUPS.AUTO_WAITING;

  const runsToday = Number(account.runs_today ?? 0);
  if (dailyLimit > 0 && runsToday >= dailyLimit) return ACCOUNT_GROUPS.AUTO_WAITING;

  return ACCOUNT_GROUPS.HEALTHY;
}

export function summarizeAccounts(accounts, { dailyLimit = 60 } = {}) {
  const groups = { healthy: [], auto_waiting: [], manual_attention: [], disabled: [] };
  for (const account of accounts ?? []) {
    groups[accountGroupOf(account, { dailyLimit })].push(account);
  }
  return {
    total: (accounts ?? []).length,
    usable: groups.healthy.length,
    ...groups,
  };
}

/* ------------------------------------------------------------ 综合状态 */

/** 把各项探测结果汇总成「现在能不能开始跑」。 */
export function runReadiness(status) {
  const blockers = [];
  const warnings = [];

  if (status.database.state !== CONNECTION_STATES.CONNECTED) {
    blockers.push({
      key: "database",
      label:
        status.database.state === CONNECTION_STATES.NOT_CONFIGURED
          ? "未配置 DATABASE_URL"
          : "PostgreSQL 连接失败",
      detail: status.database.message,
      fix: "配置 DATABASE_URL 后执行 npm run db:tunnel / npm run db:migrate",
    });
  }

  if (status.redis.state !== CONNECTION_STATES.CONNECTED) {
    blockers.push({
      key: "redis",
      label:
        status.redis.state === CONNECTION_STATES.NOT_CONFIGURED
          ? "未配置 REDIS_URL"
          : "Redis 连接失败",
      detail: status.redis.message,
      fix: "启动 Redis 并确认 REDIS_URL 指向可达地址（本机通常先执行 npm run db:tunnel）",
    });
  }

  if (status.worker.state === WORKER_STATES.OFFLINE) {
    blockers.push({
      key: "worker",
      label: "Worker 未在线",
      detail: "没有收到有效的 Worker 心跳",
      fix: "另开一个进程执行 npm run worker",
    });
  } else if (status.worker.state === WORKER_STATES.DEGRADED) {
    warnings.push({
      key: "worker",
      label: "Worker 心跳变慢",
      detail: `最近一次心跳在 ${Math.round((status.worker.ageMs ?? 0) / 1000)} 秒前`,
      fix: "确认 npm run worker 进程还在运行",
    });
  }

  if (status.accounts.total === 0) {
    blockers.push({
      key: "accounts",
      label: "尚未配置账号",
      detail: "没有账号就无法派发任何提问",
      fix: "在项目页或 npm run auth 中配置账号",
    });
  } else if (status.accounts.usable === 0) {
    blockers.push({
      key: "accounts",
      label: "没有可用账号",
      detail: "所有账号都在等待或需要人工处理",
      fix: "查看「账号」页面中的处理建议",
    });
  } else if (status.accounts.manual_attention.length > 0) {
    warnings.push({
      key: "accounts",
      label: `${status.accounts.manual_attention.length} 个账号需要人工处理`,
      detail: status.accounts.manual_attention.map((a) => a.account_key).join("、"),
      fix: "登录失效或人机验证需要在浏览器中人工完成",
    });
  }

  return { ready: blockers.length === 0, blockers, warnings };
}

/**
 * 每个请求都会走的探测。四项各自独立失败，任何一项抛错都不影响其它项。
 */
export async function buildSystemStatus({ pool, accounts = [], activeBatches = [], now = Date.now() } = {}) {
  const [database, redis] = await Promise.all([
    probeDatabase(pool).catch((error) => ({
      state: CONNECTION_STATES.UNREACHABLE,
      message: error instanceof Error ? error.message : String(error),
    })),
    probeRedis(),
  ]);

  let worker = { state: WORKER_STATES.UNKNOWN, heartbeat: null, ageMs: null };
  if (redis.state === CONNECTION_STATES.CONNECTED) {
    const heartbeat = await readWorkerHeartbeat();
    const verdict = classifyWorkerHeartbeat(heartbeat, now);
    worker = { state: verdict.state, heartbeat, ageMs: verdict.ageMs };
  } else if (redis.state === CONNECTION_STATES.NOT_CONFIGURED) {
    worker = { state: WORKER_STATES.UNKNOWN, heartbeat: null, ageMs: null };
  } else {
    // Redis 连不上时无从判断 Worker，报告为未知而不是假装离线。
    worker = { state: WORKER_STATES.UNKNOWN, heartbeat: null, ageMs: null };
  }

  const accountSummary = summarizeAccounts(accounts, {
    dailyLimit: Number(process.env.ONEGL_ACCOUNT_DAILY_LIMIT ?? 60),
  });

  const status = {
    at: new Date(now).toISOString(),
    database,
    redis,
    worker,
    accounts: accountSummary,
    activeBatches,
    host: { hostname: os.hostname(), pid: process.pid },
  };
  status.readiness = runReadiness(status);
  return status;
}

/**
 * 顶部状态条用的缓存快照：由 server 进程定时刷新，避免每个请求都探测一遍。
 * 状态条允许有几秒延迟，操作页需要更实时时会显式重新探测。
 */
let cached = null;

export function setCachedSystemStatus(status) {
  cached = status;
}

export function cachedSystemStatus() {
  return cached;
}
