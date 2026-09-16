import assert from "node:assert/strict";
import test from "node:test";

import { normalizedRouteKey, observabilityConfig } from "../src/api/observability.js";
import { staticSafetyReport } from "../src/system/readiness.js";

test("route normalization removes high-cardinality resource ids", () => {
  assert.equal(
    normalizedRouteKey("/v1/tasks/tsk_0123456789abcdef0123456789abcdef/executions"),
    "/v1/tasks/:taskId/executions",
  );
  assert.equal(
    normalizedRouteKey("/v1/executions/exe_0123456789abcdef0123456789abcdef/results"),
    "/v1/executions/:executionId/results",
  );
  assert.equal(normalizedRouteKey("/v1/batches/123/runs"), "/v1/batches/:id/runs");
});

test("production API refuses an explicitly disabled rate limit", () => {
  const report = staticSafetyReport({
    role: "api",
    env: {
      ONEGL_PRODUCTION: "true",
      DATABASE_URL: "postgresql://example.invalid/onegl",
      REDIS_URL: "redis://example.invalid:6379",
      ONEGL_STORAGE_STATE_KEY: `hex:${"11".repeat(32)}`,
      ONEGL_REQUIRE_STORAGE_STATE_ENCRYPTION: "true",
      ONEGL_WEBHOOK_SIGNING_KEY: "w".repeat(48),
      ONEGL_WEBHOOK_ALLOW_HTTP: "false",
      ONEGL_API_RATE_LIMIT_PER_MINUTE: "0",
    },
  });
  assert.equal(report.ready, false);
  assert.equal(report.checks.api_rate_limit.ready, false);
});

test("observability defaults are bounded", () => {
  const previousLimit = process.env.ONEGL_API_RATE_LIMIT_PER_MINUTE;
  const previousRetention = process.env.ONEGL_AUDIT_RETENTION_DAYS;
  delete process.env.ONEGL_API_RATE_LIMIT_PER_MINUTE;
  delete process.env.ONEGL_AUDIT_RETENTION_DAYS;
  try {
    const config = observabilityConfig();
    assert.equal(config.rate_limit_per_minute, 120);
    assert.equal(config.audit_retention_days, 30);
  } finally {
    if (previousLimit === undefined) delete process.env.ONEGL_API_RATE_LIMIT_PER_MINUTE;
    else process.env.ONEGL_API_RATE_LIMIT_PER_MINUTE = previousLimit;
    if (previousRetention === undefined) delete process.env.ONEGL_AUDIT_RETENTION_DAYS;
    else process.env.ONEGL_AUDIT_RETENTION_DAYS = previousRetention;
  }
});
