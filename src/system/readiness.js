import { readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { databaseReady } from "../db/dashboard.js";
import { checkRedis, isQueueConfigured } from "../queue/connection.js";
import { storageStateEncryptionStatus } from "../security/storage-state.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));
const execFileAsync = promisify(execFile);

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

function validHttpsEndpoint(value) {
  if (!configuredSecret(value)) return false;
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function isProductionRuntime(env = process.env) {
  return boolValue(env.ONEGL_PRODUCTION, false) || String(env.NODE_ENV ?? "").toLowerCase() === "production";
}

export function roleRequiresQueue(role) {
  return new Set(["api", "worker", "monitor", "alert"]).has(String(role || "api"));
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
  const alertEndpointValid = validHttpsEndpoint(env.ONEGL_ALERT_WEBHOOK_URL);
  const alertSigningReady = configuredSecret(env.ONEGL_ALERT_SIGNING_KEY, 32);

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
    alert_delivery: {
      ready: role !== "alert" || !production || (alertEndpointValid && alertSigningReady),
      required: role === "alert" && production,
      endpoint_configured: configuredSecret(env.ONEGL_ALERT_WEBHOOK_URL),
      endpoint_https: alertEndpointValid,
      signing_configured: alertSigningReady,
      message:
        role !== "alert" || !production || (alertEndpointValid && alertSigningReady)
          ? ""
          : "production alert worker requires a credential-free HTTPS ONEGL_ALERT_WEBHOOK_URL and ONEGL_ALERT_SIGNING_KEY with at least 32 characters",
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

/**
 * Camoufox is a runtime dependency of both the API remote-auth path and the
 * collection worker. Keep it in readiness rather than letting the first login
 * request discover a broken image. The check is opt-in by explicit
 * ONEGL_BROWSER=camoufox so local API tests do not require a browser install.
 */
export async function camoufoxRuntimeReadiness({ role = "api", env = process.env } = {}) {
  const browser = String(env.ONEGL_BROWSER ?? "").trim().toLowerCase();
  const required = browser === "camoufox" && new Set(["api", "worker"]).has(role);
  if (!required) {
    return {
      ready: true,
      required: false,
      configured: browser || null,
      version: null,
      addon: { ready: true, required: false, path: null, version: null, message: "" },
      message: "",
    };
  }

  const addonPath = String(
    env.ONEGL_CAMOUFOX_UBLOCK_PATH ?? "/opt/onegl-addons/ublock",
  ).trim() || "/opt/onegl-addons/ublock";
  const expectedAddonVersion = String(env.ONEGL_CAMOUFOX_UBLOCK_VERSION ?? "").trim();
  let addon;
  try {
    const manifest = JSON.parse(await readFile(join(addonPath, "manifest.json"), "utf8"));
    const addonId =
      manifest?.browser_specific_settings?.gecko?.id ?? manifest?.applications?.gecko?.id;
    const addonVersion = String(manifest?.version ?? "").trim();
    if (addonId !== "uBlock0@raymondhill.net") {
      throw new Error(`unexpected extension id ${addonId || "<missing>"}`);
    }
    if (!addonVersion) throw new Error("manifest.json has no version");
    if (expectedAddonVersion && addonVersion !== expectedAddonVersion) {
      throw new Error(`expected version ${expectedAddonVersion}, found ${addonVersion}`);
    }
    addon = {
      ready: true,
      required: true,
      path: addonPath,
      version: addonVersion,
      message: "",
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    addon = {
      ready: false,
      required: true,
      path: addonPath,
      version: null,
      message: `Bundled uBlock add-on is not usable: ${detail.slice(0, 240)}`,
    };
  }

  if (!addon.ready) {
    return {
      ready: false,
      required: true,
      configured: browser,
      version: null,
      addon,
      message: addon.message,
    };
  }

  const python = String(env.ONEGL_CAMOUFOX_PYTHON ?? "python3").trim() || "python3";
  try {
    const { stdout } = await execFileAsync(
      python,
      ["-c", "from camoufox.pkgman import installed_verstr; print(installed_verstr())"],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 },
    );
    const version = String(stdout).trim();
    if (!version) throw new Error("Camoufox did not report an installed version");
    return { ready: true, required: true, configured: browser, version, addon, message: "" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ready: false,
      required: true,
      configured: browser,
      version: null,
      addon,
      message: `Camoufox runtime is not installed or not usable: ${detail.slice(0, 240)}`,
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
  const camoufox = await camoufoxRuntimeReadiness({ role, env });

  const dynamic = { database, migrations, queue, camoufox };
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
