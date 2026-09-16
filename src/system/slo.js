import { checkRedis, isQueueConfigured } from "../queue/connection.js";
import { classifyWorkerHeartbeat, readWorkerHeartbeat } from "./status.js";

function numberEnv(env, name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function integerEnv(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = numberEnv(env, name, fallback, { min, max });
  return Number.isInteger(value) ? value : fallback;
}

export function sloConfig(env = process.env) {
  return {
    windowMinutes: integerEnv(env, "ONEGL_SLO_WINDOW_MINUTES", 15, { min: 5, max: 1440 }),
    apiMinRequests: integerEnv(env, "ONEGL_SLO_API_MIN_REQUESTS", 20, { min: 1, max: 1_000_000 }),
    api5xxRateMax: numberEnv(env, "ONEGL_SLO_API_5XX_RATE_MAX", 0.02, { min: 0, max: 1 }),
    apiP95MsMax: integerEnv(env, "ONEGL_SLO_API_P95_MS_MAX", 3000, { min: 1, max: 600_000 }),
    executionMinCount: integerEnv(env, "ONEGL_SLO_EXECUTION_MIN_COUNT", 5, { min: 1, max: 1_000_000 }),
    executionBadRateMax: numberEnv(env, "ONEGL_SLO_EXECUTION_BAD_RATE_MAX", 0.2, { min: 0, max: 1 }),
    manualAccountsMax: integerEnv(env, "ONEGL_SLO_MANUAL_ACCOUNTS_MAX", 0, { min: 0, max: 1_000_000 }),
    failedWebhooksMax: integerEnv(env, "ONEGL_SLO_FAILED_WEBHOOKS_MAX", 0, { min: 0, max: 1_000_000 }),
  };
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

export async function collectSloSnapshot(pool, config = sloConfig()) {
  const [api, executions, accounts, webhooks, redis] = await Promise.all([
    pool.query(
      `SELECT count(*)::bigint AS requests,
              count(*) FILTER (WHERE status >= 500)::bigint AS server_errors,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_duration_ms
         FROM service_api_audit_logs
        WHERE created_at >= now() - ($1 * interval '1 minute')`,
      [config.windowMinutes],
    ),
    pool.query(
      `SELECT count(*) FILTER (WHERE b.status IN ('completed','partial','failed'))::bigint AS terminal,
              count(*) FILTER (WHERE b.status IN ('partial','failed'))::bigint AS bad
         FROM service_task_executions e
         JOIN sampling_batches b ON b.id = e.batch_id
        WHERE e.created_at >= now() - ($1 * interval '1 minute')`,
      [config.windowMinutes],
    ),
    pool.query(
      `SELECT count(*)::bigint AS manual
         FROM accounts
        WHERE enabled = true
          AND status IN ('login_required','session_expired','verification_required','access_restricted','paused')`,
    ),
    pool.query(
      `SELECT count(*)::bigint AS failed
         FROM service_webhook_events
        WHERE status = 'failed'
          AND created_at >= now() - ($1 * interval '1 minute')`,
      [config.windowMinutes],
    ),
    isQueueConfigured() ? checkRedis() : Promise.resolve({ ready: false, message: "REDIS_URL is not configured" }),
  ]);

  let worker = { state: "unknown", age_ms: null };
  if (redis.ready) {
    const heartbeat = await readWorkerHeartbeat();
    const verdict = classifyWorkerHeartbeat(heartbeat);
    worker = { state: verdict.state, age_ms: verdict.ageMs };
  }

  const apiRow = api.rows[0] ?? {};
  const executionRow = executions.rows[0] ?? {};
  const accountRow = accounts.rows[0] ?? {};
  const webhookRow = webhooks.rows[0] ?? {};
  const requests = Number(apiRow.requests ?? 0);
  const serverErrors = Number(apiRow.server_errors ?? 0);
  const terminal = Number(executionRow.terminal ?? 0);
  const bad = Number(executionRow.bad ?? 0);

  return {
    observed_at: new Date().toISOString(),
    window_minutes: config.windowMinutes,
    api: {
      requests,
      server_errors: serverErrors,
      server_error_rate: ratio(serverErrors, requests),
      p95_duration_ms: apiRow.p95_duration_ms == null ? null : Number(apiRow.p95_duration_ms),
    },
    executions: {
      terminal,
      bad,
      bad_rate: ratio(bad, terminal),
    },
    accounts: {
      manual_attention: Number(accountRow.manual ?? 0),
    },
    webhooks: {
      failed: Number(webhookRow.failed ?? 0),
    },
    redis: {
      ready: Boolean(redis.ready),
      message: redis.message ?? "",
    },
    worker,
  };
}

function alert(key, severity, summary, details) {
  return { key, severity, summary, details };
}

export function evaluateSloSnapshot(snapshot, config = sloConfig()) {
  const alerts = [];

  if (!snapshot.redis?.ready) {
    alerts.push(alert(
      "redis_unavailable",
      "critical",
      "Redis is unavailable; queue execution and distributed API controls are degraded.",
      { message: snapshot.redis?.message || "Redis is unavailable" },
    ));
  } else if (["offline", "unknown"].includes(snapshot.worker?.state)) {
    alerts.push(alert(
      "worker_offline",
      "critical",
      "Doubao worker heartbeat is offline.",
      { state: snapshot.worker?.state ?? "unknown", heartbeat_age_ms: snapshot.worker?.age_ms ?? null },
    ));
  } else if (snapshot.worker?.state === "degraded") {
    alerts.push(alert(
      "worker_heartbeat_degraded",
      "warning",
      "Doubao worker heartbeat is delayed.",
      { state: snapshot.worker.state, heartbeat_age_ms: snapshot.worker.age_ms ?? null },
    ));
  }

  const api = snapshot.api ?? {};
  if (Number(api.requests ?? 0) >= config.apiMinRequests) {
    if (api.server_error_rate != null && api.server_error_rate > config.api5xxRateMax) {
      alerts.push(alert(
        "api_5xx_rate_high",
        "critical",
        "API 5xx rate is above the configured SLO threshold.",
        {
          requests: Number(api.requests),
          server_errors: Number(api.server_errors ?? 0),
          observed_rate: Number(api.server_error_rate),
          threshold: config.api5xxRateMax,
          window_minutes: snapshot.window_minutes,
        },
      ));
    }
    if (api.p95_duration_ms != null && Number(api.p95_duration_ms) > config.apiP95MsMax) {
      alerts.push(alert(
        "api_p95_high",
        "warning",
        "API p95 latency is above the configured SLO threshold.",
        {
          requests: Number(api.requests),
          observed_ms: Number(api.p95_duration_ms),
          threshold_ms: config.apiP95MsMax,
          window_minutes: snapshot.window_minutes,
        },
      ));
    }
  }

  const executions = snapshot.executions ?? {};
  if (Number(executions.terminal ?? 0) >= config.executionMinCount
    && executions.bad_rate != null
    && Number(executions.bad_rate) > config.executionBadRateMax) {
    alerts.push(alert(
      "execution_bad_rate_high",
      "critical",
      "Execution partial/failed rate is above the configured SLO threshold.",
      {
        terminal: Number(executions.terminal),
        partial_or_failed: Number(executions.bad ?? 0),
        observed_rate: Number(executions.bad_rate),
        threshold: config.executionBadRateMax,
        window_minutes: snapshot.window_minutes,
      },
    ));
  }

  const manualAccounts = Number(snapshot.accounts?.manual_attention ?? 0);
  if (manualAccounts > config.manualAccountsMax) {
    alerts.push(alert(
      "accounts_need_manual_attention",
      "warning",
      "One or more Doubao accounts require manual attention.",
      { count: manualAccounts, threshold: config.manualAccountsMax },
    ));
  }

  const failedWebhooks = Number(snapshot.webhooks?.failed ?? 0);
  if (failedWebhooks > config.failedWebhooksMax) {
    alerts.push(alert(
      "webhook_delivery_failed",
      "warning",
      "One or more webhook events exhausted delivery retries in the SLO window.",
      { count: failedWebhooks, threshold: config.failedWebhooksMax, window_minutes: snapshot.window_minutes },
    ));
  }

  return alerts.sort((left, right) => {
    const rank = { critical: 0, warning: 1 };
    return rank[left.severity] - rank[right.severity] || left.key.localeCompare(right.key);
  });
}
