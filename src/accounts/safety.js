/**
 * 账号安全层。
 *
 * 目标不是绕过平台风控，而是避免自动化脚本在账号异常时持续撞击平台：
 * 达到条件就停下来等人工处理，而不是无限重试。
 *
 * 这里不做任何验证码识别或限制规避。
 */

function intEnv(name, fallback, min = 1) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`${name} 必须是不小于 ${min} 的整数`);
  }
  return parsed;
}

export function safetyConfig() {
  const minDelayMs = intEnv("ONEGL_MIN_DELAY_MS", 4_000, 0);
  const maxDelayMs = intEnv("ONEGL_MAX_DELAY_MS", 9_000, 0);
  if (maxDelayMs < minDelayMs) {
    throw new Error("ONEGL_MAX_DELAY_MS 不能小于 ONEGL_MIN_DELAY_MS");
  }
  return {
    minDelayMs,
    maxDelayMs,
    accountDailyLimit: intEnv("ONEGL_ACCOUNT_DAILY_LIMIT", 60),
    maxConsecutiveFailures: intEnv("ONEGL_MAX_CONSECUTIVE_FAILURES", 3),
    cooldownMinutes: intEnv("ONEGL_ACCOUNT_COOLDOWN_MINUTES", 30, 1),
    accountParallelism: intEnv("ONEGL_ACCOUNT_PARALLELISM", 1),
  };
}

/** 两次提问之间在配置区间内随机等待，降低机械化请求与服务端突发负载。 */
export function randomDelayMs({ minDelayMs, maxDelayMs }) {
  if (maxDelayMs <= minDelayMs) return minDelayMs;
  return minDelayMs + Math.floor(Math.random() * (maxDelayMs - minDelayMs + 1));
}

/** 需要停下来等人工处理的错误：绝不自动重试。 */
export const ACCOUNT_BLOCKING_CODES = {
  DOUBAO_LOGIN_REQUIRED: {
    status: "login_required",
    manual: true,
    message: "豆包未登录，需要人工重新执行 npm run auth",
  },
  DOUBAO_SESSION_EXPIRED: {
    status: "session_expired",
    manual: true,
    message: "登录态已失效，需要人工重新执行 npm run auth",
  },
  DOUBAO_VERIFICATION_REQUIRED: {
    status: "verification_required",
    manual: true,
    message: "触发人机验证，已停止自动运行，需要人工在浏览器中处理",
  },
  DOUBAO_ACCESS_RESTRICTED: {
    status: "access_restricted",
    manual: true,
    message: "账号被限制访问，已停止自动运行",
  },
  RATE_LIMITED: {
    status: "rate_limited",
    manual: false,
    message: "触发频率限制，进入冷却",
  },
};

/** 明确属于临时性错误，允许有限重试。其余一律不重试。 */
export const RETRYABLE_CODES = new Set([
  "DOUBAO_TIMEOUT",
  "NETWORK_ERROR",
  // Playwright 自身的瞬时超时（元素被重渲染等）也走这里，重试上限同样是 2 次
  "UNKNOWN_ERROR",
  // 会话没能确认是干净的新会话：属于页面状态问题，重试可能就好，但绝不带着旧上下文提问。
  "DOUBAO_CONVERSATION_RESET_FAILED",
]);

export function isRetryable(code) {
  return RETRYABLE_CODES.has(code);
}

export function isBlocking(code) {
  return Object.prototype.hasOwnProperty.call(ACCOUNT_BLOCKING_CODES, code);
}

// ---------------------------------------------------------------------------
// 自然日与时区
//
// 「每日提问上限」必须按账号所在的自然日算。OneGl 当前只面向中国豆包账号，
// 用 UTC 自然日会让北京时间 08:00 之前的提问算到前一天，限额实际是错位的。
// 因此这里显式使用账号时区，不依赖服务器本地时区。
// ---------------------------------------------------------------------------

export const DEFAULT_ACCOUNT_TIME_ZONE = "Asia/Shanghai";

export function accountTimeZone() {
  const raw = process.env.ONEGL_ACCOUNT_TIMEZONE;
  const value = raw == null || String(raw).trim() === "" ? DEFAULT_ACCOUNT_TIME_ZONE : String(raw).trim();
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value });
  } catch {
    throw new Error(
      `ONEGL_ACCOUNT_TIMEZONE ${JSON.stringify(value)} 不是有效的 IANA 时区，例如 Asia/Shanghai`,
    );
  }
  return value;
}

/** 某个瞬间在账号时区里属于哪一天，返回 YYYY-MM-DD。 */
export function accountDayKey(now = new Date(), timeZone = accountTimeZone()) {
  // en-CA 的短日期格式就是 YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** 该瞬间与账号时区之间的偏移（毫秒）。 */
function timeZoneOffsetMs(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** 账号时区里的下一个零点（每日限额的重置时刻）。 */
export function nextAccountDayStart(now = new Date(), timeZone = accountTimeZone()) {
  const offset = timeZoneOffsetMs(now, timeZone);
  const shifted = new Date(now.getTime() + offset);
  const nextMidnight = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() + 1,
    0,
    0,
    0,
  );
  return new Date(nextMidnight - offset);
}

/** 把 pg 返回的 date 列（可能是 Date，也可能是字符串）归一成 YYYY-MM-DD。 */
export function dateKeyOf(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    // node-postgres 把 date 解析成本地零点的 Date，因此读本地分量。
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  const matched = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
  return matched ? matched[1] : null;
}

// ---------------------------------------------------------------------------
// 账号可用性判定（纯逻辑，便于离线测试）
// ---------------------------------------------------------------------------

export const AVAILABILITY = Object.freeze({
  AVAILABLE: "available",
  // 临时：冷却、频率限制、当日额度用完。任务应当延迟到 retryAt 再跑，不能丢掉。
  TEMPORARY: "temporary",
  // 永久/人工：禁用、登录失效、需要验证码、被限制访问、人工暂停。
  // 这类要停止继续撞账号，等人工处理。
  PERMANENT: "permanent",
});

export function classifyAccountState(state, { config = safetyConfig(), now = new Date() } = {}) {
  if (!state) return { kind: AVAILABILITY.AVAILABLE, reason: null, retryAt: null };

  if (!state.enabled) {
    return { kind: AVAILABILITY.PERMANENT, reason: "账号已被禁用", retryAt: null };
  }
  if (state.paused_at && !state.cooldown_until) {
    return {
      kind: AVAILABILITY.PERMANENT,
      reason: state.pause_reason ?? "账号已暂停",
      retryAt: null,
    };
  }

  const cooldownUntil = state.cooldown_until ? new Date(state.cooldown_until) : null;
  if (cooldownUntil && cooldownUntil > now) {
    return {
      kind: AVAILABILITY.TEMPORARY,
      reason: `冷却中，至 ${cooldownUntil.toLocaleString("zh-CN")}`,
      retryAt: cooldownUntil,
    };
  }

  const today = accountDayKey(now);
  const runsToday =
    dateKeyOf(state.runs_today_date) === today ? Number(state.runs_today) || 0 : 0;
  if (runsToday >= config.accountDailyLimit) {
    return {
      kind: AVAILABILITY.TEMPORARY,
      reason: `已达每日上限 ${config.accountDailyLimit} 次`,
      retryAt: nextAccountDayStart(now),
    };
  }

  return { kind: AVAILABILITY.AVAILABLE, reason: null, retryAt: null };
}

const ENSURE_ACCOUNT = `
  INSERT INTO accounts (account_key, provider)
  VALUES ($1, $2)
  ON CONFLICT (provider, account_key) DO UPDATE SET updated_at = now()
  RETURNING id
`;

export async function ensureAccountRow(pool, accountKey, provider = "doubao") {
  await pool.query(ENSURE_ACCOUNT, [accountKey, provider]);
}

export async function getAccountState(pool, accountKey, provider = "doubao") {
  const { rows } = await pool.query(
    `SELECT account_key, provider, enabled, status, last_run_at, runs_today, runs_today_date,
            consecutive_failures, cooldown_until, paused_at, pause_reason, last_error_code,
            last_health_status, last_health_checked_at, storage_state_present
       FROM accounts WHERE provider = $2 AND account_key = $1`,
    [accountKey, provider],
  );
  return rows[0] ?? null;
}

/**
 * 是否可以继续给这个账号派活。
 *
 * kind 决定调用方的动作：
 *   available -> 正常执行
 *   temporary -> 延迟到 retryAt 再跑，不能把任务丢掉
 *   permanent -> 跳过并停止继续撞击该账号，等人工处理
 */
export async function accountAvailability(pool, accountKey, config = safetyConfig()) {
  const state = await getAccountState(pool, accountKey);
  const verdict = classifyAccountState(state, { config });
  return {
    available: verdict.kind === AVAILABILITY.AVAILABLE,
    kind: verdict.kind,
    reason: verdict.reason,
    retryAt: verdict.retryAt,
    state,
  };
}

/** 记录一次即将开始的提问，并按账号时区的自然日重置计数。 */
export async function beginAccountRun(pool, accountKey, provider = "doubao") {
  const today = accountDayKey();
  await pool.query(
    `UPDATE accounts
        SET runs_today = CASE
              WHEN runs_today_date IS NULL OR runs_today_date <> $3::date THEN 1
              ELSE runs_today + 1
            END,
            runs_today_date = $3::date,
            last_run_at = now(),
            last_health_status = 'healthy',
            last_health_checked_at = now(),
            status = CASE WHEN status IN ('cooldown', 'rate_limited') THEN 'healthy' ELSE status END,
            cooldown_until = CASE WHEN status IN ('cooldown', 'rate_limited') THEN NULL ELSE cooldown_until END,
            updated_at = now()
      WHERE provider = $2 AND account_key = $1`,
    [accountKey, provider, today],
  );
}

export async function recordAccountSuccess(pool, accountKey, provider = "doubao") {
  await pool.query(
    `UPDATE accounts
        SET consecutive_failures = 0,
            status = 'healthy',
            last_health_status = 'healthy',
            last_health_checked_at = now(),
            pause_reason = NULL,
            paused_at = NULL,
            cooldown_until = NULL,
            updated_at = now()
      WHERE provider = $2 AND account_key = $1`,
    [accountKey, provider],
  );
}

/**
 * 记录失败。命中阻塞类错误时直接暂停/冷却；普通失败累计到阈值后进入冷却。
 * 返回一个说明对象，供调用方决定是否跳过该账号的后续任务。
 */
export async function recordAccountFailure(
  pool,
  { accountKey, errorCode, provider = "doubao", config = safetyConfig() },
) {
  const blocking = ACCOUNT_BLOCKING_CODES[errorCode];

  if (blocking) {
    const cooldownUntil = blocking.manual
      ? null
      : new Date(Date.now() + config.cooldownMinutes * 60_000).toISOString();
    await pool.query(
      `UPDATE accounts
          SET status = $3,
              paused_at = now(),
              pause_reason = $4,
              last_error_code = $5,
              last_health_status = $3,
              last_health_checked_at = now(),
              cooldown_until = $6,
              updated_at = now()
        WHERE provider = $2 AND account_key = $1`,
      [accountKey, provider, blocking.status, blocking.message, errorCode, cooldownUntil],
    );
    return { blocked: true, status: blocking.status, message: blocking.message, manual: blocking.manual };
  }

  const { rows } = await pool.query(
    `UPDATE accounts
        SET consecutive_failures = consecutive_failures + 1,
            last_error_code = $3,
            last_health_status = 'degraded',
            last_health_checked_at = now(),
            updated_at = now()
      WHERE provider = $2 AND account_key = $1
      RETURNING consecutive_failures`,
    [accountKey, provider, errorCode ?? null],
  );

  const failures = Number(rows[0]?.consecutive_failures ?? 0);
  if (failures >= config.maxConsecutiveFailures) {
    const cooldownUntil = new Date(Date.now() + config.cooldownMinutes * 60_000).toISOString();
    await pool.query(
      `UPDATE accounts
          SET status = 'cooldown',
              cooldown_until = $3,
              paused_at = now(),
              pause_reason = $4,
              updated_at = now()
        WHERE provider = $2 AND account_key = $1`,
      [
        accountKey,
        provider,
        cooldownUntil,
        `连续失败 ${failures} 次，冷却 ${config.cooldownMinutes} 分钟`,
      ],
    );
    return {
      blocked: true,
      status: "cooldown",
      message: `连续失败 ${failures} 次，已进入冷却`,
      manual: false,
    };
  }

  return { blocked: false, status: "degraded", failures };
}

/** 人工解除暂停/冷却。 */
export async function resumeAccount(pool, accountKey, provider = "doubao") {
  const { rowCount } = await pool.query(
    `UPDATE accounts
        SET status = 'healthy',
            paused_at = NULL,
            pause_reason = NULL,
            cooldown_until = NULL,
            consecutive_failures = 0,
            updated_at = now()
      WHERE provider = $2 AND account_key = $1`,
    [accountKey, provider],
  );
  return rowCount > 0;
}

export async function setAccountEnabled(pool, accountKey, enabled, provider = "doubao") {
  const { rowCount } = await pool.query(
    `UPDATE accounts
        SET enabled = $3,
            status = CASE WHEN $3 THEN 'unknown' ELSE 'disabled' END,
            updated_at = now()
      WHERE provider = $2 AND account_key = $1`,
    [accountKey, provider, enabled],
  );
  return rowCount > 0;
}

export async function markStorageStatePresent(pool, accountKey, present, provider = "doubao") {
  await pool.query(
    `UPDATE accounts SET storage_state_present = $3, updated_at = now()
      WHERE provider = $2 AND account_key = $1`,
    [accountKey, provider, present],
  );
}
