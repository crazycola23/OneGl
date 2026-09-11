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
]);

export function isRetryable(code) {
  return RETRYABLE_CODES.has(code);
}

export function isBlocking(code) {
  return Object.prototype.hasOwnProperty.call(ACCOUNT_BLOCKING_CODES, code);
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

/** 是否可以继续给这个账号派活。 */
export async function accountAvailability(pool, accountKey, config = safetyConfig()) {
  const state = await getAccountState(pool, accountKey);
  if (!state) return { available: true, reason: null, state: null };

  if (!state.enabled) {
    return { available: false, reason: "账号已被禁用", state };
  }
  if (state.paused_at && !state.cooldown_until) {
    return { available: false, reason: state.pause_reason ?? "账号已暂停", state };
  }
  if (state.cooldown_until && new Date(state.cooldown_until) > new Date()) {
    return {
      available: false,
      reason: `冷却中，至 ${new Date(state.cooldown_until).toLocaleString("zh-CN")}`,
      state,
    };
  }

  const today = new Date().toISOString().slice(0, 10);
  const runsToday =
    state.runs_today_date && String(state.runs_today_date).slice(0, 10) === today
      ? Number(state.runs_today)
      : 0;
  if (runsToday >= config.accountDailyLimit) {
    return { available: false, reason: `已达每日上限 ${config.accountDailyLimit} 次`, state };
  }

  return { available: true, reason: null, state };
}

/** 记录一次即将开始的提问，并按自然日重置计数。 */
export async function beginAccountRun(pool, accountKey, provider = "doubao") {
  const today = new Date().toISOString().slice(0, 10);
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
