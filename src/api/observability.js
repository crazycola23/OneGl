import crypto from "node:crypto";
import http from "node:http";

import { createPool, isDatabaseConfigured } from "../db/pool.js";
import { getRedis, isQueueConfigured, queuePrefix } from "../queue/connection.js";
import { isProductionRuntime } from "../system/readiness.js";

const REQUEST_ID_PATTERN = /^req_[a-f0-9]{32}$/;
const installedSymbol = Symbol.for("onegl.api.observability.installed");
const originalCreateServerSymbol = Symbol.for("onegl.api.observability.originalCreateServer");
const counters = new Map();
let auditCleanupAfter = 0;

function intEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function requestId() {
  return `req_${crypto.randomUUID().replaceAll("-", "")}`;
}

function readCredential(req) {
  const authorization = String(req.headers.authorization ?? "");
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1];
  return String(bearer || req.headers["x-api-key"] || "");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ""));
  const b = Buffer.from(String(right ?? ""));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export function normalizedRouteKey(pathname) {
  return String(pathname || "/")
    .replace(/\/tsk_[a-f0-9]{16,}/gi, "/:taskId")
    .replace(/\/exe_[a-f0-9]{16,}/gi, "/:executionId")
    .replace(/\/res_[a-f0-9]{16,}/gi, "/:resultId")
    .replace(/\/rpt_[a-f0-9]{16,}/gi, "/:reportId")
    .replace(/\/sch_[a-f0-9]{16,}/gi, "/:scheduleId")
    .replace(/\/run_[A-Za-z0-9_-]+/g, "/:runId")
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "/:id")
    .replace(/\/\d+(?=\/|$)/g, "/:id");
}

function rateLimitIdentity(req) {
  const credential = readCredential(req);
  if (credential) return `credential:${sha256(credential).slice(0, 32)}`;
  return `anonymous:${sha256(req.socket?.remoteAddress || "unknown").slice(0, 32)}`;
}

async function enforceRateLimit(req, res) {
  const limit = intEnv("ONEGL_API_RATE_LIMIT_PER_MINUTE", 120, { min: 0, max: 1_000_000 });
  if (limit === 0) return { enabled: false, limited: false };
  if (!isQueueConfigured()) {
    if (isProductionRuntime()) throw new Error("Redis is unavailable for API rate limiting");
    return { enabled: false, limited: false };
  }

  const now = Date.now();
  const window = Math.floor(now / 60_000);
  const resetMs = (window + 1) * 60_000;
  const key = `${queuePrefix()}:api-rate:v1:${rateLimitIdentity(req)}:${window}`;
  const redis = getRedis();
  let count;
  try {
    const result = await redis.multi().incr(key).expire(key, 120).exec();
    count = Number(result?.[0]?.[1] ?? 0);
  } catch (error) {
    if (isProductionRuntime()) throw error;
    return { enabled: false, limited: false };
  }

  const remaining = Math.max(0, limit - count);
  res.setHeader("x-ratelimit-limit", String(limit));
  res.setHeader("x-ratelimit-remaining", String(remaining));
  res.setHeader("x-ratelimit-reset", String(Math.floor(resetMs / 1000)));
  if (count <= limit) return { enabled: true, limited: false, limit, remaining, resetMs };

  const retryAfter = Math.max(1, Math.ceil((resetMs - now) / 1000));
  res.setHeader("retry-after", String(retryAfter));
  return { enabled: true, limited: true, limit, remaining: 0, resetMs, retryAfter };
}

function captureErrorCode(res, chunk) {
  if (res.statusCode < 400 || chunk == null) return null;
  const contentType = String(res.getHeader("content-type") ?? "");
  if (!contentType.includes("application/json")) return null;
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  if (buffer.length > 64 * 1024) return null;
  try {
    const parsed = JSON.parse(buffer.toString("utf8"));
    return typeof parsed?.error === "string" ? parsed.error.slice(0, 200) : null;
  } catch {
    return null;
  }
}

async function writeAudit(pool, entry, req) {
  if (!pool) return;
  const credential = readCredential(req);
  const keyHash = credential ? sha256(credential) : null;
  const master = Boolean(credential && process.env.ONEGL_API_KEY && safeEqual(credential, process.env.ONEGL_API_KEY));
  const masterTenantSlug = master ? String(req.headers["x-onegl-tenant"] ?? "").trim().toLowerCase() || null : null;
  try {
    await pool.query(
      `WITH client AS (
         SELECT id, tenant_id FROM service_api_clients WHERE key_hash = $1 LIMIT 1
       ), master_tenant AS (
         SELECT id FROM service_tenants WHERE $2::text IS NOT NULL AND slug = $2 LIMIT 1
       )
       INSERT INTO service_api_audit_logs
         (request_id, tenant_id, client_id, auth_kind, method, path, route_key, status, duration_ms,
          error_code, idempotency_replayed, rate_limited)
       SELECT $3,
              COALESCE((SELECT tenant_id FROM client), CASE WHEN $4 THEN (SELECT id FROM master_tenant) ELSE NULL END),
              (SELECT id FROM client),
              CASE WHEN $4 THEN 'master' WHEN EXISTS (SELECT 1 FROM client) THEN 'client' ELSE 'anonymous' END,
              $5, $6, $7, $8, $9, $10, $11, $12`,
      [
        keyHash,
        masterTenantSlug,
        entry.requestId,
        master,
        entry.method,
        entry.path,
        entry.routeKey,
        entry.status,
        entry.durationMs,
        entry.errorCode,
        entry.idempotencyReplayed,
        entry.rateLimited,
      ],
    );
    await maybeCleanupAudit(pool);
  } catch (error) {
    console.error(`[audit] failed to persist request metadata: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function maybeCleanupAudit(pool) {
  const now = Date.now();
  if (now < auditCleanupAfter) return;
  auditCleanupAfter = now + 60 * 60 * 1000;
  const days = intEnv("ONEGL_AUDIT_RETENTION_DAYS", 30, { min: 1, max: 3650 });
  await pool.query(
    "DELETE FROM service_api_audit_logs WHERE created_at < now() - ($1 * interval '1 day')",
    [days],
  ).catch(() => undefined);
}

function counterKey(parts) {
  return parts.join("\u0000");
}

function incrementCounter(parts, value = 1) {
  const key = counterKey(parts);
  counters.set(key, (counters.get(key) ?? 0) + value);
}

function observeRequest({ method, routeKey, status, durationMs, rateLimited }) {
  const statusClass = `${Math.floor(Number(status) / 100)}xx`;
  incrementCounter(["requests", method, routeKey, statusClass]);
  incrementCounter(["duration_count", method, routeKey]);
  incrementCounter(["duration_sum", method, routeKey], durationMs);
  if (rateLimited) incrementCounter(["rate_limited"]);
}

function metricEsc(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function metricLine(name, labels, value) {
  const labelText = Object.entries(labels || {})
    .map(([key, label]) => `${key}="${metricEsc(label)}"`)
    .join(",");
  return `${name}${labelText ? `{${labelText}}` : ""} ${Number(value) || 0}`;
}

async function databaseMetricLines(pool) {
  if (!pool) return [metricLine("onegl_database_ready", {}, 0)];
  const lines = [metricLine("onegl_database_ready", {}, 1)];
  try {
    const [accounts, executions, webhooks, deliveries, runs] = await Promise.all([
      pool.query("SELECT a.status, count(*)::bigint AS n FROM accounts a GROUP BY a.status ORDER BY a.status"),
      pool.query(`SELECT COALESCE(b.status, 'pending') AS status, count(*)::bigint AS n
                    FROM service_task_executions e
                    LEFT JOIN sampling_batches b ON b.id = e.batch_id
                   GROUP BY COALESCE(b.status, 'pending') ORDER BY 1`),
      pool.query("SELECT status, count(*)::bigint AS n FROM service_webhook_events GROUP BY status ORDER BY status"),
      pool.query("SELECT status, count(*)::bigint AS n FROM service_webhook_deliveries GROUP BY status ORDER BY status"),
      pool.query("SELECT status, count(*)::bigint AS n FROM runs GROUP BY status ORDER BY status"),
    ]);
    for (const row of accounts.rows) lines.push(metricLine("onegl_accounts", { status: row.status }, row.n));
    for (const row of executions.rows) lines.push(metricLine("onegl_executions", { status: row.status }, row.n));
    for (const row of webhooks.rows) lines.push(metricLine("onegl_webhook_events", { status: row.status }, row.n));
    for (const row of deliveries.rows) lines.push(metricLine("onegl_webhook_deliveries", { status: row.status }, row.n));
    for (const row of runs.rows) lines.push(metricLine("onegl_runs", { status: row.status }, row.n));
  } catch (error) {
    lines[0] = metricLine("onegl_database_ready", {}, 0);
    lines.push(`# onegl_database_metrics_error ${JSON.stringify(error instanceof Error ? error.message : String(error))}`);
  }
  return lines;
}

async function prometheusMetrics(pool) {
  const lines = [
    "# HELP onegl_api_requests_total API requests observed by this API process.",
    "# TYPE onegl_api_requests_total counter",
  ];
  for (const [key, value] of counters.entries()) {
    const [kind, a, b, c] = key.split("\u0000");
    if (kind === "requests") lines.push(metricLine("onegl_api_requests_total", { method: a, route: b, status: c }, value));
  }
  lines.push("# HELP onegl_api_request_duration_ms API request duration accumulated by this API process.");
  lines.push("# TYPE onegl_api_request_duration_ms_sum counter");
  for (const [key, value] of counters.entries()) {
    const [kind, method, route] = key.split("\u0000");
    if (kind === "duration_sum") lines.push(metricLine("onegl_api_request_duration_ms_sum", { method, route }, value));
    if (kind === "duration_count") lines.push(metricLine("onegl_api_request_duration_ms_count", { method, route }, value));
  }
  lines.push(metricLine("onegl_api_rate_limited_total", {}, counters.get(counterKey(["rate_limited"])) ?? 0));
  lines.push(...await databaseMetricLines(pool));
  return `${lines.join("\n")}\n`;
}

function authorizedMetrics(req) {
  const configured = String(process.env.ONEGL_METRICS_TOKEN ?? "").trim();
  if (!configured) return false;
  const authorization = String(req.headers.authorization ?? "");
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1] ?? "";
  return safeEqual(bearer, configured);
}

function sendMetricsError(res, status, message) {
  const body = JSON.stringify({ error: status === 401 ? "unauthorized" : "not_found", message });
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function sendRateLimitResponse(res, state) {
  const body = JSON.stringify({
    error: "api_rate_limited",
    message: "API request rate limit exceeded",
    details: {
      limit_per_minute: state.limit,
      retry_after_seconds: state.retryAfter,
      reset_at: new Date(state.resetMs).toISOString(),
    },
  });
  res.writeHead(429, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function sendRateLimitUnavailable(res) {
  const body = JSON.stringify({ error: "rate_limit_unavailable", message: "API rate limiter is unavailable" });
  res.writeHead(503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

export function installApiObservability() {
  if (http[installedSymbol]) return;
  http[installedSymbol] = true;
  if (!http[originalCreateServerSymbol]) http[originalCreateServerSymbol] = http.createServer.bind(http);
  const originalCreateServer = http[originalCreateServerSymbol];
  const auditPool = isDatabaseConfigured() ? createPool() : null;

  http.createServer = function oneglCreateServer(listener) {
    return originalCreateServer(async (req, res) => {
      const started = process.hrtime.bigint();
      const id = requestId();
      res.setHeader("x-onegl-request-id", id);
      let url;
      try {
        url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      } catch {
        url = new URL("/", "http://localhost");
      }
      const pathname = url.pathname;
      const routeKey = normalizedRouteKey(pathname);
      const auditThis = pathname === "/v1" || pathname.startsWith("/v1/");
      let capturedErrorCode = null;
      let rateLimited = false;

      const originalEnd = res.end.bind(res);
      res.end = function observedEnd(chunk, ...args) {
        capturedErrorCode = capturedErrorCode || captureErrorCode(res, chunk);
        return originalEnd(chunk, ...args);
      };

      if (auditThis) {
        res.once("finish", () => {
          const durationMs = Math.max(0, Math.round(Number(process.hrtime.bigint() - started) / 1_000_000));
          const entry = {
            requestId: id,
            method: req.method || "GET",
            path: pathname,
            routeKey,
            status: res.statusCode || 500,
            durationMs,
            errorCode: capturedErrorCode,
            idempotencyReplayed: String(res.getHeader("idempotency-replayed") ?? "").toLowerCase() === "true",
            rateLimited,
          };
          observeRequest(entry);
          void writeAudit(auditPool, entry, req);
        });
      }

      if (pathname === "/metrics") {
        if (!process.env.ONEGL_METRICS_TOKEN) return sendMetricsError(res, 404, "route not found");
        if (!authorizedMetrics(req)) return sendMetricsError(res, 401, "valid metrics credentials are required");
        const text = await prometheusMetrics(auditPool);
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" });
        return res.end(text);
      }

      if (auditThis) {
        try {
          const state = await enforceRateLimit(req, res);
          if (state.limited) {
            rateLimited = true;
            capturedErrorCode = "api_rate_limited";
            return sendRateLimitResponse(res, state);
          }
        } catch (error) {
          if (isProductionRuntime()) {
            capturedErrorCode = "rate_limit_unavailable";
            return sendRateLimitUnavailable(res);
          }
          console.warn(`[rate-limit] ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      return listener(req, res);
    });
  };
}

export function observabilityConfig() {
  return {
    request_id_format: REQUEST_ID_PATTERN.source,
    rate_limit_per_minute: intEnv("ONEGL_API_RATE_LIMIT_PER_MINUTE", 120, { min: 0, max: 1_000_000 }),
    audit_retention_days: intEnv("ONEGL_AUDIT_RETENTION_DAYS", 30, { min: 1, max: 3650 }),
    metrics_enabled: Boolean(String(process.env.ONEGL_METRICS_TOKEN ?? "").trim()),
  };
}
