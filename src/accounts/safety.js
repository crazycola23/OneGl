/**
 * 账号安全层。
 *
 * 目标不是绕过平台风控，而是避免自动化脚本在账号异常时持续撞击平台：
 * 达到条件就停下来等人工处理，而不是无限重试。
 *
 * 这里不做任何验证码识别、行为伪装或限制规避。
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
  const minDelayMs = intEnv("ONEGL_MIN_DELAY_MS", 30_000, 0);
  const maxDelayMs = intEnv("ONEGL_MAX_DELAY_MS", 90_000, 0);
  if (maxDelayMs < minDelayMs) {
    throw new Error("ONEGL_MAX_DELAY_MS 不能小于 ONEGL_MIN_DELAY_MS");
  }
  return {
    minDelayMs,
    maxDelayMs,
    minInterRunMs: intEnv("ONEGL_MIN_INTER_RUN_SECONDS", 45, 0) * 1_000,
    accountHourlyLimit: intEnv("ONEGL_ACCOUNT_HOURLY_LIMIT", 10, 1),
    accountDailyLimit: intEnv("ONEGL_ACCOUNT_DAILY_LIMIT", 40),
    maxConsecutiveFailures: intEnv("ONEGL_MAX_CONSECUTIVE_FAILURES", 3),
    cooldownMinutes: intEnv("ONEGL_ACCOUNT_COOLDOWN_MINUTES", 60, 1),
    rateLimitCooldownMinutes: intEnv("ONEGL_RATE_LIMIT_COOLDOWN_MINUTES", 180, 1),
    accountParallelism: intEnv("ONEGL_ACCOUNT_PARALLELISM", 1),
  };
}

export function randomDelayMs({ minDelayMs, maxDelayMs }) {
  if (maxDelayMs <= minDelayMs) return minDelayMs;
  return minDelayMs + Math.floor(Math.random() * (maxDelayMs - minDelayMs + 1));
}

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
    message: "触发频率限制，进入长冷却",
  },
};

// Failures in OneGl's own persistence/queue/storage layers are not observations about
// the provider account. They must never increment provider consecutive_failures or put
// a healthy Doubao account into cooldown.
export const INFRASTRUCTURE_ERROR_CODES = new Set([
  "DATABASE_ERROR",
  "REDIS_ERROR",
  "STORAGE_ERROR",
]);

export const RETRYABLE_CODES = new Set([
  "DOUBAO_TIMEOUT",
  "NETWORK_ERROR",
  "DOUBAO_CONVERSATION_RESET_FAILED",
]);

export const RESUBMIT_UNSAFE_CODES = new Set([
  "DOUBAO_TIMEOUT",
  "NETWORK_ERROR",
]);

export function isRetryable(code) {
  return RETRYABLE_CODES.has(code);
}

export function canRetryOutcome(code, details = null) {
  if (!RETRYABLE_CODES.has(code)) return false;
  if (!RESUBMIT_UNSAFE_CODES.has(code)) return true;
  return details?.promptSubmitted === false;
}

export function isBlocking(code) {
  return Object.prototype.hasOwnProperty.call(ACCOUNT_BLOCKING_CODES, code);
}

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

export function accountDayKey(now = new Date(), timeZone = accountTimeZone()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

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

export function dateKeyOf(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  const matched = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
  return matched ? matched[1] : null;
}

export const AVAILABILITY = Object.freeze({
  AVAILABLE: "available",
  TEMPORARY: "temporary",
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

  const minInterRunMs = Number(config.minInterRunMs ?? 0);
  const lastRunAt = state.last_run_at ? new Date(state.last_run_at) : null;
  if (lastRunAt && minInterRunMs > 0) {
    const retryAt = new Date(lastRunAt.getTime() + minInterRunMs);
    if (retryAt > now) {
      return {
        kind: AVAILABILITY.TEMPORARY,
        reason: `距离上次运行过近，至少间隔 ${Math.ceil(minInterRunMs / 1000)} 秒`,
        retryAt,
      };
    }
  }

  const hourlyLimit = Number(config.accountHourlyLimit ?? Number.POSITIVE_INFINITY);
  const runsLastHour = Number(state.runs_last_hour ?? 0);
  if (Number.isFinite(hourlyLimit) && runsLastHour >= hourlyLimit) {
    const oldest = state.hour_window_oldest ? new Date(state.hour_window_oldest) : now;
    const retryAt = new Date(oldest.getTime() + 60 * 60_000 + 1_000);
    return {
      kind: AVAILABILITY.TEMPORARY,
      reason: `已达每小时上限 ${hourlyLimit} 次`,
      retryAt: retryAt > now ? retryAt : new Date(now.getTime() + 60_000),
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
    `SELECT a.account_key, a.provider, a.enabled, a.status, a.last_run_at,
            a.runs_today, a.runs_today_date, a.consecutive_failures, a.cooldown_until,
            a.paused_at, a.pause_reason, a.last_error_code, a.last_health_status,
            a.last_health_checked_at, a.storage_state_present,
            COALESCE((
              SELECT count(*)::integer
                FROM runs r
               WHERE r.account_key = a.account_key
                 AND r.provider = a.provider
                 AND r.started_at >= now() - interval '1 hour'
            ), 0) AS runs_last_hour,
            (
              SELECT min(r.started_at)
                FROM runs r
               WHERE r.account_key = a.account_key
                 AND r.provider = a.provider
                 AND r.started_at >= now() - interval '1 hour'
            ) AS hour_window_oldest
       FROM accounts a
      WHERE a.provider = $2 AND a.account_key = $1`,
    [accountKey, provider],
  );
  return rows[0] ?? null;
}

export async function accountAvailability(pool, accountKey, config = safetyConfig(), provider = "doubao") {
  const state = await getAccountState(pool, accountKey, provider);
  const verdict = classifyAccountState(state, { config });
  return {
    available: verdict.kind === AVAILABILITY.AVAILABLE,
    kind: verdict.kind,
    reason: verdict.reason,
    retryAt: verdict.retryAt,
    state,
  };
}

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

export async function recordAccountFailure(
  pool,
  { accountKey, errorCode, provider = "doubao", config = safetyConfig() },
) {
  if (INFRASTRUCTURE_ERROR_CODES.has(errorCode)) {
    return {
      blocked: false,
      status: "infrastructure_error",
      failures: null,
      infrastructure: true,
    };
  }

  const blocking = ACCOUNT_BLOCKING_CODES[errorCode];

  if (blocking) {
    const cooldownMinutes =
      errorCode === "RATE_LIMITED"
        ? Number(config.rateLimitCooldownMinutes ?? config.cooldownMinutes)
        : config.cooldownMinutes;
    const cooldownUntil = blocking.manual
      ? null
      : new Date(Date.now() + cooldownMinutes * 60_000).toISOString();
    const message =
      errorCode === "RATE_LIMITED"
        ? `${blocking.message} ${cooldownMinutes} 分钟`
        : blocking.message;
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
      [accountKey, provider, blocking.status, message, errorCode, cooldownUntil],
    );
    return { blocked: true, status: blocking.status, message, manual: blocking.manual };
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
