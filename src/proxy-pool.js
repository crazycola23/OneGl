import { readFileSync } from "node:fs";
import {
  buildExit,
  normalizeProxyServer,
  poolError,
  requireNonEmptyString,
  resolveCredentialPair,
} from "./proxy-record.js";
import { extractProxyExits, parseHttpApiSource, redactUrl } from "./proxy-source-http-api.js";

/**
 * 通用代理池 —— 契约见 docs/2026-10-15_proxy-pool-interface-v1.md。
 *
 * 两个输入源：
 *   · `static`   —— 固定出口列表，稳定分配（自己有一台常驻代理网关时用）
 *   · `http_api` —— 调供应商的提取接口拿出口（能买到的池子几乎都是这种）
 *
 * 这一层的唯一硬约束是「不许静默直连」：一旦配置了必需代理池却拿不到可用出口，
 * 启动浏览器这一步就必须失败。把代理故障伪装成正常采集，比采集失败昂贵得多。
 *
 * 调度模式（`acquisition.mode`）：
 *   · `pooled`      —— 按 (平台, 账号, 槽位) 稳定绑定一个出口，到期才换
 *   · `per_session` —— 每次会话取一个没用过的出口，用完即弃（短效轮换池用这个）
 *
 * 槽位必须进分配键：只用 (平台, 账号) 时同一个账号的多个槽位会拿到同一个出口 IP，
 * 而收紧槽位的依据正是「同账号多窗口高频提交被惩罚」—— 那次实验没有 IP 池，
 * 4 个窗口本来就共用一个 IP。放开槽位却不带槽位选出口，等于原样重现那个失败配置。
 */

const SCHEMA_VERSION = 1;
const SUPPORTED_SOURCE_KINDS = new Set(["static", "http_api"]);
const SUPPORTED_STABILITY_MODES = new Set(["fixed", "until_expiry"]);
/** 一条会话从「拿到出口」到「问答结束」的墙钟预算：冷启动 11s + 回答 10–40s + 收尾余量。 */
const DEFAULT_MIN_SESSION_LIFETIME_MS = 120_000;
/** per_session 模式下已消费出口的记忆上限，防止长跑时无限增长。 */
const CONSUMED_HISTORY_LIMIT = 5_000;

// 兼容旧调用方：这两个校验函数从 proxy-record.js 移出后仍然从这里导出。
export { normalizeProxyServer, resolveCredentialPair };

function parseStaticSource(source, env) {
  if (source == null || typeof source !== "object" || Array.isArray(source)) {
    throw poolError("proxy source must be an object");
  }
  const items = source.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw poolError("static proxy source must provide a non-empty items array");
  }
  const seen = new Set();
  return items.map((item, index) => {
    if (item == null || typeof item !== "object" || Array.isArray(item)) {
      throw poolError(`proxy exit at index ${index} must be an object`);
    }
    const id = requireNonEmptyString(item.id ?? `exit_${index + 1}`, `proxy exit id at index ${index}`);
    if (seen.has(id)) throw poolError(`duplicate proxy exit id ${JSON.stringify(id)}`);
    seen.add(id);
    const stability = String(item.stability?.mode ?? "fixed").trim();
    if (!SUPPORTED_STABILITY_MODES.has(stability)) {
      throw poolError(
        `proxy exit ${id} stability ${JSON.stringify(stability)} is unsupported; expected fixed or until_expiry`,
      );
    }
    const { username, password } = resolveCredentialPair(item.auth, env);
    return buildExit({
      id,
      server: item.server,
      stability,
      username,
      password,
      expiresAt: null,
      sourceId: id,
    });
  });
}

export function parseProxyPool(document, { env = process.env } = {}) {
  if (document == null || typeof document !== "object" || Array.isArray(document)) {
    throw poolError("proxy pool config must be a JSON object");
  }
  const schemaVersion = Number(document.schema_version);
  if (schemaVersion !== SCHEMA_VERSION) {
    throw poolError(
      `proxy pool schema_version ${JSON.stringify(document.schema_version)} is unsupported; expected ${SCHEMA_VERSION}`,
    );
  }
  const poolId = requireNonEmptyString(document.pool_id, "pool_id");
  const sourceKind = document.source?.kind;
  if (!SUPPORTED_SOURCE_KINDS.has(sourceKind)) {
    throw poolError(
      `proxy pool ${poolId} source.kind ${JSON.stringify(sourceKind)} is unsupported; expected static or http_api`,
    );
  }
  const platforms = Array.isArray(document.platforms) ? document.platforms : [];
  const acquisitionMode = String(document.acquisition?.mode ?? "pooled").trim().toLowerCase();
  if (acquisitionMode !== "pooled" && acquisitionMode !== "per_session") {
    throw poolError(
      `proxy pool ${poolId} acquisition.mode ${JSON.stringify(document.acquisition?.mode)} is unsupported; expected pooled or per_session`,
    );
  }
  if (sourceKind === "static" && acquisitionMode === "per_session") {
    throw poolError(
      `proxy pool ${poolId} cannot use acquisition.mode=per_session with a static source (fixed exits never change)`,
    );
  }
  const minLifetime = Number(document.min_session_lifetime_ms ?? DEFAULT_MIN_SESSION_LIFETIME_MS);
  if (!Number.isFinite(minLifetime) || minLifetime < 0) {
    throw poolError(`proxy pool ${poolId} min_session_lifetime_ms must be a non-negative number`);
  }
  return {
    poolId,
    enabled: document.enabled === true,
    required: document.required === true,
    platforms: platforms.map((entry) => requireNonEmptyString(entry, "platforms[]")),
    sourceKind,
    acquisition: { mode: acquisitionMode },
    minSessionLifetimeMs: minLifetime,
    ...(sourceKind === "static"
      ? { exits: parseStaticSource(document.source, env) }
      : { api: parseHttpApiSource(document.source, { env }) }),
  };
}

/** FNV-1a：稳定分配的键在同一份配置上必须永远落到同一个出口。 */
export function stableHash(value) {
  let hash = 0x811c9dc5;
  const text = String(value ?? "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function assignmentKey({ platform = null, accountKey = null, slot = 0 } = {}) {
  const index = Number.isInteger(slot) && slot > 0 ? slot : 0;
  return `${platform ?? ""}|${accountKey ?? ""}|${index}`;
}

function isExpired(exit, now, minRemainingMs) {
  if (exit?.expires_at == null) return false;
  return exit.expires_at - now < minRemainingMs;
}

/**
 * 按 (平台, 账号, 槽位) 稳定分配出口。
 *
 * 出口数少于槽位时必然碰撞（哈希空间小于取值数），这是已知且可接受的：
 * 出口预算是按 (平台, 出口) 记的，碰撞只意味着那两个槽位共享预算。
 */
export function selectExit(
  pool,
  { platform = null, accountKey = null, slot = 0, now = Date.now(), minRemainingMs = 0 } = {},
) {
  const usable = (pool.exits ?? []).filter((exit) => !isExpired(exit, now, minRemainingMs));
  if (usable.length === 0) return null;
  return usable[stableHash(assignmentKey({ platform, accountKey, slot })) % usable.length];
}

/**
 * 配置了入口文件却读不到 / 解析不了，属于「加载失败」，按契约必须阻断，
 * 不能让任务掉回直连。
 */
export function loadProxyPool(file, { env = process.env } = {}) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    throw poolError(`proxy pool file ${file} could not be read: ${error?.message ?? error}`, { file });
  }
  let document;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw poolError(`proxy pool file ${file} is not valid JSON: ${error?.message ?? error}`, { file });
  }
  try {
    return parseProxyPool(document, { env });
  } catch (error) {
    throw poolError(`proxy pool file ${file} is invalid: ${error?.message ?? error}`, { file });
  }
}

/**
 * 池子的运行期状态：已提取到的出口、已消费的出口、稳定绑定表。
 * 进程内单份 —— 跨进程共享租约属于后续阶段（见接口文档第 4 节），这里不假装有。
 */
const poolStates = new Map();

function stateFor(file, pool) {
  const key = `${file}::${pool.poolId}`;
  let state = poolStates.get(key);
  if (!state) {
    state = {
      exits: new Map(),
      consumed: new Set(),
      assignment: new Map(),
      lastExtractAt: 0,
      inflight: null,
      extractions: 0,
      lastError: null,
    };
    poolStates.set(key, state);
  }
  return state;
}

/** 只给测试和诊断用：清掉进程内的池子状态。 */
export function resetPoolState(file = null, poolId = null) {
  if (file == null) {
    poolStates.clear();
    return;
  }
  for (const key of [...poolStates.keys()]) {
    if (!key.startsWith(`${file}::`)) continue;
    if (poolId != null && key !== `${file}::${poolId}`) continue;
    poolStates.delete(key);
  }
}

function pruneState(state, pool, now) {
  for (const [id, exit] of [...state.exits]) {
    if (exit.expires_at != null && exit.expires_at <= now) {
      state.exits.delete(id);
      state.consumed.delete(id);
    }
  }
  const max = pool.api?.inventory.max_pool_size ?? 50;
  while (state.exits.size > max) {
    const oldest = state.exits.keys().next().value;
    state.exits.delete(oldest);
    state.consumed.delete(oldest);
  }
  if (state.consumed.size > CONSUMED_HISTORY_LIMIT) {
    for (const id of [...state.consumed]) {
      if (!state.exits.has(id)) state.consumed.delete(id);
      if (state.consumed.size <= CONSUMED_HISTORY_LIMIT / 2) break;
    }
  }
  for (const [key, id] of [...state.assignment]) {
    if (!state.exits.has(id)) state.assignment.delete(key);
  }
}

/**
 * 从缓存里挑一个可用出口。
 *
 * `preferKey` 不为空时按哈希挑，并**优先挑还没被别的键占用的**：
 * 2026-10-16 实测 —— 「取第一个可用」会让同一个账号的每个槽位都拿到同一个出口，
 * 那正是收紧槽位时那个失败配置（4 个窗口共用一个 IP）原样重现。哈希保证分散，
 * 「优先未占用」保证池子够大时槽位之间真的不撞；池子不够大时允许碰撞，这是已知的。
 */
function pickUsable(state, { now, minRemainingMs, excludeConsumed, preferKey = null }) {
  const candidates = [];
  for (const exit of state.exits.values()) {
    if (excludeConsumed && state.consumed.has(exit.id)) continue;
    if (isExpired(exit, now, minRemainingMs)) continue;
    candidates.push(exit);
  }
  if (candidates.length === 0) return null;
  if (preferKey == null) return candidates[0];
  const taken = new Set(state.assignment.values());
  const free = candidates.filter((exit) => !taken.has(exit.id));
  const from = free.length > 0 ? free : candidates;
  return from[stableHash(preferKey) % from.length];
}

/**
 * 刷新库存。三件事必须一起做，少一件就会变成对供应商接口的洪泛：
 *   1. 单飞 —— N 个并发的会话创建只触发一次提取
 *   2. 最小刷新间隔 —— 池子刚空了也不许立刻重试，撞供应商的 QPS 上限是要被封 key 的
 *   3. 失败也记时间 —— 否则「供应商挂了」会退化成每秒钟重试一次
 */
async function refreshInventory(pool, state, { fetchImpl, env }) {
  if (state.inflight) return state.inflight;
  const minIntervalMs = (pool.api.inventory.min_refresh_interval_seconds ?? 30) * 1000;
  state.inflight = (async () => {
    const waitMs = state.lastExtractAt + minIntervalMs - Date.now();
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    try {
      const { exits, rejected } = await extractProxyExits(pool.api, {
        fetchImpl,
        env,
        now: Date.now(),
      });
      for (const exit of exits) state.exits.set(exit.id, exit);
      state.extractions += 1;
      state.lastError = null;
      if (rejected.length > 0) {
        console.warn(
          `[proxy-pool] ${pool.poolId} 提取到 ${exits.length} 个可用出口，${rejected.length} 个被拒：${rejected.slice(0, 3).join("; ")}`,
        );
      }
      return exits;
    } catch (error) {
      state.lastError = error?.message ?? String(error);
      throw error;
    } finally {
      state.lastExtractAt = Date.now();
      state.inflight = null;
      pruneState(state, pool, Date.now());
    }
  })();
  return state.inflight;
}

async function acquireFromApi(pool, state, { key, mode, minRemainingMs, fetchImpl, env }) {
  const excludeConsumed = mode === "per_session";

  if (mode === "pooled") {
    const boundId = state.assignment.get(key);
    if (boundId != null) {
      const bound = state.exits.get(boundId);
      // 绑定的出口还在有效期内就直接复用 —— 这就是「会话粘性」，
      // 每次冷启动都换 IP 会让平台看到「同一台设备在到处跳」。
      if (bound && !isExpired(bound, Date.now(), minRemainingMs)) return bound;
      state.assignment.delete(key);
    }
  }

  const preferKey = mode === "pooled" ? key : null;
  let exit = pickUsable(state, { now: Date.now(), minRemainingMs, excludeConsumed, preferKey });
  if (!exit) {
    await refreshInventory(pool, state, { fetchImpl, env });
    exit = pickUsable(state, { now: Date.now(), minRemainingMs, excludeConsumed, preferKey });
  }
  if (!exit) {
    throw poolError(
      `proxy pool ${pool.poolId} has no usable exit for ${key}${state.lastError ? ` (last extract error: ${state.lastError})` : ""}`,
      { pool_id: pool.poolId, floor: "proxy_pool_exhausted", last_error: state.lastError },
    );
  }
  if (mode === "per_session") state.consumed.add(exit.id);
  else state.assignment.set(key, exit.id);
  return exit;
}

function describeExit(exit, pool) {
  return { ...exit, poolId: pool.poolId, required: pool.required, mode: pool.acquisition.mode };
}

/** 平台是否由这份池子服务（platforms 为空 = 全平台）。 */
export function poolAppliesTo(pool, platform) {
  return pool.platforms.length === 0 || pool.platforms.includes(platform);
}

/**
 * 会话出口的唯一**同步**解析入口（只支持 static）。
 *
 * 返回 null 表示「本次保持直连」——只有三种情况会这样：
 * 没配入口文件、池未启用且非必需、平台不在池的 platforms 列表里。
 *
 * `http_api` 必须走 `acquireSessionProxy`：提取要发网络请求，同步接口做不到，
 * 这里显式拒绝而不是偷偷回退直连。
 */
export function resolveSessionProxy(
  config = {},
  {
    platform = config.provider ?? null,
    accountKey = config.accountKey ?? null,
    slot = 0,
    env = process.env,
  } = {},
) {
  const file = config.proxyPoolFile;
  if (file == null || String(file).trim() === "") return null;

  const pool = loadProxyPool(String(file).trim(), { env });
  if (!poolAppliesTo(pool, platform)) return null;

  if (!pool.enabled) {
    if (pool.required) {
      throw poolError(`proxy pool ${pool.poolId} is required for platform ${platform} but disabled`, {
        pool_id: pool.poolId,
        platform,
      });
    }
    return null;
  }

  if (pool.sourceKind !== "static") {
    throw poolError(
      `proxy pool ${pool.poolId} uses source.kind=${pool.sourceKind}; the synchronous resolver only handles static pools — call acquireSessionProxy() instead`,
      { pool_id: pool.poolId, platform },
    );
  }

  const exit = selectExit(pool, {
    platform,
    accountKey,
    slot,
    minRemainingMs: pool.minSessionLifetimeMs,
  });
  if (!exit) {
    throw poolError(`proxy pool ${pool.poolId} has no usable exit for platform ${platform}`, {
      pool_id: pool.poolId,
      platform,
    });
  }
  return describeExit(exit, pool);
}

/**
 * 会话出口的**异步**解析入口 —— 两个输入源都支持，浏览器工厂走这条。
 *
 * @param {object} config loadConfig() 的产物（只读 proxyPoolFile / provider / accountKey）
 * @param {{platform?: string, accountKey?: string, slot?: number, minRemainingMs?: number,
 *          fetchImpl?: Function, env?: object}} [options]
 * @returns {Promise<object|null>} 出口记录（含 poolId / mode），或 null = 直连
 */
export async function acquireSessionProxy(
  config = {},
  {
    platform = config.provider ?? null,
    accountKey = config.accountKey ?? null,
    slot = 0,
    minRemainingMs = null,
    fetchImpl = globalThis.fetch,
    env = process.env,
  } = {},
) {
  const file = config.proxyPoolFile;
  if (file == null || String(file).trim() === "") return null;
  const resolvedFile = String(file).trim();
  const pool = loadProxyPool(resolvedFile, { env });
  if (!poolAppliesTo(pool, platform)) return null;

  if (!pool.enabled) {
    if (pool.required) {
      throw poolError(`proxy pool ${pool.poolId} is required for platform ${platform} but disabled`, {
        pool_id: pool.poolId,
        platform,
      });
    }
    return null;
  }

  const lifetime =
    Number.isFinite(minRemainingMs) && minRemainingMs >= 0 ? minRemainingMs : pool.minSessionLifetimeMs;

  if (pool.sourceKind === "static") {
    const exit = selectExit(pool, { platform, accountKey, slot, minRemainingMs: lifetime });
    if (!exit) {
      throw poolError(`proxy pool ${pool.poolId} has no usable exit for platform ${platform}`, {
        pool_id: pool.poolId,
        platform,
      });
    }
    return describeExit(exit, pool);
  }

  const state = stateFor(resolvedFile, pool);
  const key = assignmentKey({ platform, accountKey, slot });
  const exit = await acquireFromApi(pool, state, {
    key,
    mode: pool.acquisition.mode,
    minRemainingMs: lifetime,
    fetchImpl,
    env,
  });
  return describeExit(exit, pool);
}

/**
 * 归还一个出口并登记健康结果。
 *
 * `pooled` 模式下失败会把绑定清掉 —— 下一次会话重新选一个，但**不**立刻重发当前任务：
 * 换出口不是重试手段，只是下一次任务的起点（见路线图第 3 节的处置表）。
 */
export function releaseSessionProxy(file, exit, { ok = true, reason = null } = {}) {
  if (!exit || !file) return;
  const prefix = `${String(file).trim()}::`;
  const key = [...poolStates.keys()].find((entry) => entry.startsWith(prefix));
  if (!key) return;
  const state = poolStates.get(key);
  // 同时接受原始出口记录和 describeProxy() 的产物 —— 调用方常常只握着「可安全落库的那份」。
  const exitId = exit.id ?? exit.exit_id ?? null;
  if (!state || !exitId) return;
  if (!ok) {
    state.exits.delete(exitId);
    for (const [assignment, id] of [...state.assignment]) {
      if (id === exitId) state.assignment.delete(assignment);
    }
    if (reason) console.warn(`[proxy-pool] 出口 ${exitId} 标记为不可用：${reason}`);
  }
}

/** 运行期统计：提取了几次、还剩几个可用出口、上次错在哪。 */
export function poolRuntimeSummary(file, poolId) {
  const state = poolStates.get(`${String(file).trim()}::${poolId}`);
  if (!state) return null;
  const now = Date.now();
  const live = [...state.exits.values()].filter((exit) => !isExpired(exit, now, 0));
  return {
    cached_exits: state.exits.size,
    live_exits: live.length,
    consumed_exits: state.consumed.size,
    assignments: state.assignment.size,
    extractions: state.extractions,
    last_extract_at: state.lastExtractAt ? new Date(state.lastExtractAt).toISOString() : null,
    last_error: state.lastError,
  };
}

/** Playwright 的 proxy 选项。凭据只在进程内存里流转，从不进日志。 */
export function playwrightProxy(exit) {
  if (!exit) return undefined;
  return {
    server: exit.server,
    ...(exit.username ? { username: exit.username, password: exit.password } : {}),
  };
}

/** 可安全写进日志/落库的身份描述，不含凭据。 */
export function describeProxy(exit) {
  if (!exit) return null;
  return {
    pool_id: exit.poolId ?? null,
    exit_id: exit.id ?? null,
    server: exit.server,
    authenticated: Boolean(exit.username),
    stability: exit.stability ?? null,
    required: exit.required === true,
    mode: exit.mode ?? null,
    expires_at: exit.expires_at == null ? null : new Date(exit.expires_at).toISOString(),
  };
}

/** 池子的脱敏描述，给体检工具与运维日志用。 */
export function describePool(pool, file = null) {
  const base = {
    pool_id: pool.poolId,
    file,
    enabled: pool.enabled,
    required: pool.required,
    platforms: pool.platforms,
    source_kind: pool.sourceKind,
    acquisition_mode: pool.acquisition.mode,
    min_session_lifetime_ms: pool.minSessionLifetimeMs,
  };
  if (pool.sourceKind === "static") {
    return {
      ...base,
      exits: pool.exits.map((exit) => describeProxy({ ...exit, poolId: pool.poolId })),
    };
  }
  return {
    ...base,
    request: {
      method: pool.api.request.method,
      url: redactUrl(pool.api.request.url),
      auth: pool.api.request.auth.type,
      timeout_ms: pool.api.request.timeout_ms,
    },
    response: {
      format: pool.api.response.format,
      items_path: pool.api.response.items_path,
      default_scheme: pool.api.response.default_scheme,
      expiry_format: pool.api.response.expiry_format,
    },
    stability: pool.api.stability.mode,
    inventory: pool.api.inventory,
  };
}
