import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { databaseReady } from "../db/dashboard.js";
import { checkRedis, isQueueConfigured } from "../queue/connection.js";
import { storageStateEncryptionStatus } from "../security/storage-state.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

function boolValue(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function configuredSecret(value, minimum = 1) {
  return typeof value === "string" && value.trim().length >= minimum;
}

function positiveInteger(value, fallback) {
  if (value == null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function isProductionRuntime(env = process.env) {
  return boolValue(env.ONEGL_PRODUCTION, false) || String(env.NODE_ENV ?? "").toLowerCase() === "production";
}

export function roleRequiresQueue(role) {
  return new Set(["api", "worker", "monitor"]).has(String(role || "api"));
}

export function staticSafetyReport({ role = "api", env = process.env } = {}) {
  const production = isProductionRuntime(env);
  const storage = storageStateEncryptionStatus({
    storageStateKey: env.ONEGL_STORAGE_STATE_KEY ?? null,
    requireStorageStateEncryption: boolValue(env.ONEGL_REQUIRE_STORAGE_STATE_ENCRYPTION, false),
  });
  const needsStorageState = new Set(["api", "worker"]).has(role);
  const needsWebhookSigning = new Set(["api", "webhook"]).has(role);
  const needsQueue = roleRequiresQueue(role);
  const allowHttpWebhook = boolValue(env.ONEGL_WEBHOOK_ALLOW_HTTP, false);
  const apiRateLimit = positiveInteger(env.ONEGL_API_RATE_LIMIT_PER_MINUTE, 120);

  const checks = {
    database_configured: {
      ready: configuredSecret(env.DATABASE_URL),
      required: true,
      message: configuredSecret(env.DATABASE_URL) ? "" : "DATABASE_URL is not configured",
    },
    queue_configured: {
      ready: !needsQueue || configuredSecret(env.REDIS_URL),
      required: needsQueue,
      message: !needsQueue || configuredSecret(env.REDIS_URL) ? "" : "REDIS_URL is not configured",
    },
    storage_state_encryption: {
      ready: !needsStorageState || !production || (storage.configured && storage.valid && storage.required),
      required: needsStorageState && production,
      configured: storage.configured,
      enforced: storage.required,
      valid: storage.valid,
      algorithm: storage.algorithm,
      message:
        !needsStorageState || !production || (storage.configured && storage.valid && storage.required)
          ? ""
          : "production API/worker requires a valid ONEGL_STORAGE_STATE_KEY and ONEGL_REQUIRE_STORAGE_STATE_ENCRYPTION=true",
    },
    webhook_signing: {
      ready: !needsWebhookSigning || !production || configuredSecret(env.ONEGL_WEBHOOK_SIGNING_KEY, 32),
      required: needsWebhookSigning && production,
      configured: configuredSecret(env.ONEGL_WEBHOOK_SIGNING_KEY),
      message:
        !needsWebhookSigning || !production || configuredSecret(env.ONEGL_WEBHOOK_SIGNING_KEY, 32)
          ? ""
          : "production API/webhook worker requires ONEGL_WEBHOOK_SIGNING_KEY with at least 32 characters",
    },
    webhook_https_only: {
      ready: !production || !allowHttpWebhook,
      required: production,
      message: !production || !allowHttpWebhook ? "" : "ONEGL_WEBHOOK_ALLOW_HTTP must be disabled in production",
    },
    api_rate_limit: {
      ready: role !== "api" || !production || apiRateLimit !== null,
      required: role === "api" && production,
      limit_per_minute: apiRateLimit,
      message:
        role !== "api" || !production || apiRateLimit !== null
          ? ""
          : "production API requires ONEGL_API_RATE_LIMIT_PER_MINUTE to be a positive integer",
    },
  };

  const advisory = {
    master_api_key: {
      configured: configuredSecret(env.ONEGL_API_KEY),
      message: configuredSecret(env.ONEGL_API_KEY)
        ? ""
        : "ONEGL_API_KEY is not configured; tenant client keys still work but master/bootstrap admin calls are unavailable",
    },
    metrics_endpoint: {
      configured: configuredSecret(env.ONEGL_METRICS_TOKEN, 32),
      message: configuredSecret(env.ONEGL_METRICS_TOKEN, 32)
        ? ""
        : "ONEGL_METRICS_TOKEN is not configured; /metrics remains disabled",
    },
  };

  return {
    role,
    production,
    ready: Object.values(checks).every((check) => check.ready),
    checks,
    advisory,
  };
}

export function assertProductionSafety(options = {}) {
  const report = staticSafetyReport(options);
  if (!report.production || report.ready) return report;
  const failures = Object.entries(report.checks)
    .filter(([, check]) => !check.ready)
    .map(([name, check]) => `${name}: ${check.message || "not ready"}`);
  throw new Error(`OneGl production safety check failed (${report.role}): ${failures.join("; ")}`);
}

async function migrationReadiness(pool) {
  if (!pool) return { ready: false, pending: [], message: "database pool is unavailable" };
  try {
    const local = (await readdir(MIGRATIONS_DIR))
      .filter((name) => name.endsWith(".sql"))
      .map((name) => name.replace(/\.sql$/, ""))
      .sort();
    const { rows } = await pool.query("SELECT version FROM schema_migrations ORDER BY version");
    const applied = new Set(rows.map((row) => row.version));
    const pending = local.filter((version) => !applied.has(version));
    return {
      ready: pending.length === 0,
      local_count: local.length,
      applied_count: local.filter((version) => applied.has(version)).length,
      pending,
      message: pending.length ? `${pending.length} database migration(s) are pending` : "",
    };
  } catch (error) {
    return {
      ready: false,
      pending: [],
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function readinessReport({ pool = null, role = "api", env = process.env } = {}) {
  const staticReport = staticSafetyReport({ role, env });
  const database = pool
    ? await databaseReady(pool)
    : { ready: false, message: "DATABASE_URL is not configured" };
  const migrations = database.ready
    ? await migrationReadiness(pool)
    : { ready: false, pending: [], message: "database is not ready" };
  const queue = roleRequiresQueue(role)
    ? await checkRedis()
    : { ready: true, configured: isQueueConfigured(), message: "queue is not required for this role" };

  const dynamic = { database, migrations, queue };
  const ready = staticReport.ready && Object.values(dynamic).every((check) => check.ready);
  return {
    service: `onegl-${role}`,
    status: ready ? "ready" : "not_ready",
    ready,
    production: staticReport.production,
    checks: {
      ...staticReport.checks,
      ...dynamic,
    },
    advisory: staticReport.advisory,
  };
}
