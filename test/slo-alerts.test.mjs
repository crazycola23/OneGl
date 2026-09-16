import assert from "node:assert/strict";
import test from "node:test";

import { staticSafetyReport } from "../src/system/readiness.js";
import { evaluateSloSnapshot } from "../src/system/slo.js";

const config = {
  windowMinutes: 15,
  apiMinRequests: 20,
  api5xxRateMax: 0.02,
  apiP95MsMax: 3000,
  executionMinCount: 5,
  executionBadRateMax: 0.2,
  manualAccountsMax: 0,
  failedWebhooksMax: 0,
};

function healthySnapshot(overrides = {}) {
  return {
    window_minutes: 15,
    api: { requests: 100, server_errors: 1, server_error_rate: 0.01, p95_duration_ms: 500 },
    executions: { terminal: 10, bad: 1, bad_rate: 0.1 },
    accounts: { manual_attention: 0 },
    webhooks: { failed: 0 },
    redis: { ready: true, message: "" },
    worker: { state: "online", age_ms: 5000 },
    ...overrides,
  };
}

test("healthy SLO snapshot has no alerts", () => {
  assert.deepEqual(evaluateSloSnapshot(healthySnapshot(), config), []);
});

test("SLO evaluator emits critical and warning alerts from aggregate signals", () => {
  const alerts = evaluateSloSnapshot(healthySnapshot({
    api: { requests: 100, server_errors: 5, server_error_rate: 0.05, p95_duration_ms: 4500 },
    executions: { terminal: 10, bad: 3, bad_rate: 0.3 },
    accounts: { manual_attention: 2 },
    webhooks: { failed: 1 },
    worker: { state: "offline", age_ms: 120000 },
  }), config);
  const byKey = new Map(alerts.map((item) => [item.key, item]));
  assert.equal(byKey.get("worker_offline")?.severity, "critical");
  assert.equal(byKey.get("api_5xx_rate_high")?.severity, "critical");
  assert.equal(byKey.get("api_p95_high")?.severity, "warning");
  assert.equal(byKey.get("execution_bad_rate_high")?.severity, "critical");
  assert.equal(byKey.get("accounts_need_manual_attention")?.severity, "warning");
  assert.equal(byKey.get("webhook_delivery_failed")?.severity, "warning");
});

test("small samples do not trigger rate/latency SLO alerts", () => {
  const alerts = evaluateSloSnapshot(healthySnapshot({
    api: { requests: 2, server_errors: 2, server_error_rate: 1, p95_duration_ms: 99999 },
    executions: { terminal: 1, bad: 1, bad_rate: 1 },
  }), config);
  assert.equal(alerts.some((item) => item.key.startsWith("api_")), false);
  assert.equal(alerts.some((item) => item.key === "execution_bad_rate_high"), false);
});

test("production alert role requires Redis, HTTPS endpoint and signing key", () => {
  const base = {
    ONEGL_PRODUCTION: "true",
    DATABASE_URL: "postgresql://example.invalid/onegl",
    REDIS_URL: "redis://example.invalid:6379",
    ONEGL_ALERT_WEBHOOK_URL: "https://ops.example.com/onegl",
    ONEGL_ALERT_SIGNING_KEY: "a".repeat(40),
  };
  assert.equal(staticSafetyReport({ role: "alert", env: base }).ready, true);
  assert.equal(staticSafetyReport({ role: "alert", env: { ...base, ONEGL_ALERT_WEBHOOK_URL: "http://ops.example.com/onegl" } }).ready, false);
  assert.equal(staticSafetyReport({ role: "alert", env: { ...base, ONEGL_ALERT_SIGNING_KEY: "short" } }).ready, false);
  assert.equal(staticSafetyReport({ role: "alert", env: { ...base, REDIS_URL: "" } }).ready, false);
});
