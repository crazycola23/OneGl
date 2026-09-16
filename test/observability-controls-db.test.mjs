import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

import pg from "pg";
import { createApiClient } from "../src/api/service-store.js";

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;

function startApi(port, prefix) {
  const child = spawn(process.execPath, ["src/api-entry.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ONEGL_API_HOST: "127.0.0.1",
      ONEGL_API_PORT: String(port),
      ONEGL_API_KEY: "observability-master-key",
      ONEGL_PRODUCTION: "true",
      ONEGL_STORAGE_STATE_KEY: `hex:${"11".repeat(32)}`,
      ONEGL_REQUIRE_STORAGE_STATE_ENCRYPTION: "true",
      ONEGL_WEBHOOK_SIGNING_KEY: "observability-webhook-signing-key-32-chars-minimum",
      ONEGL_API_RATE_LIMIT_PER_MINUTE: "2",
      ONEGL_AUDIT_RETENTION_DAYS: "30",
      ONEGL_METRICS_TOKEN: "observability-metrics-token-32-characters-minimum",
      ONEGL_QUEUE_PREFIX: prefix,
      DATABASE_URL,
      REDIS_URL,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  return { child, output: () => ({ stdout, stderr }) };
}

async function waitForApi(processInfo, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = processInfo.output();
    if (out.stdout.includes("OneGl Service API:")) return;
    if (processInfo.child.exitCode !== null) throw new Error(`API exited early\n${out.stdout}\n${out.stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const out = processInfo.output();
  throw new Error(`API did not start\n${out.stdout}\n${out.stderr}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

async function waitForAudit(pool, ids, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await pool.query(
      `SELECT request_id, tenant_id, client_id, auth_kind, method, path, route_key,
              status, duration_ms, error_code, rate_limited
         FROM service_api_audit_logs
        WHERE request_id = ANY($1::text[])
        ORDER BY id`,
      [ids],
    );
    if (rows.length === ids.length) return rows;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("audit rows were not persisted in time");
}

function runTool(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL },
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`${script} failed\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

test("API observability persists tenant/client audit, rate-limits across Redis, and exposes protected metrics", async (t) => {
  if (!DATABASE_URL || !REDIS_URL) return t.skip("DATABASE_URL and REDIS_URL are required");
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const suffix = `${process.pid}_${Date.now()}`;
  const port = 35000 + (process.pid % 1000);
  let processInfo;
  let clientName = null;
  try {
    const tenant = (await pool.query("SELECT id FROM service_tenants WHERE slug = 'default'" )).rows[0];
    assert.ok(tenant?.id);
    clientName = `observability-${suffix}`;
    const client = await createApiClient(pool, {
      tenantId: Number(tenant.id),
      name: clientName,
    });
    processInfo = startApi(port, `onegl-observability-${suffix}`);
    await waitForApi(processInfo);
    const base = `http://127.0.0.1:${port}`;

    const specResponse = await fetch(`${base}/openapi.json`);
    assert.equal(specResponse.status, 200);
    const spec = await specResponse.json();
    assert.ok(spec.paths["/v1/tasks"].get.responses["200"].headers["X-OneGl-Request-Id"]);
    assert.ok(spec.paths["/v1/tasks"].get.responses["200"].headers["X-RateLimit-Limit"]);
    assert.ok(spec.paths["/v1/tasks"].get.responses["429"]);
    assert.ok(spec.paths["/v1/tasks"].get.responses["429"].headers["Retry-After"]);

    const requestIds = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await fetch(`${base}/v1/projects`, {
        headers: { authorization: `Bearer ${client.api_key}` },
      });
      const id = response.headers.get("x-onegl-request-id");
      assert.match(id, /^req_[a-f0-9]{32}$/);
      assert.equal(response.headers.get("x-onegl-api-version"), "0.7.0");
      requestIds.push(id);
      if (index < 2) {
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("x-ratelimit-limit"), "2");
      } else {
        assert.equal(response.status, 429);
        assert.equal((await response.json()).error, "api_rate_limited");
        assert.ok(Number(response.headers.get("retry-after")) >= 1);
      }
    }

    const rows = await waitForAudit(pool, requestIds);
    assert.deepEqual(rows.map((row) => Number(row.status)), [200, 200, 429]);
    assert.ok(rows.every((row) => Number(row.tenant_id) === Number(tenant.id)));
    assert.ok(rows.every((row) => Number(row.client_id) === Number(client.id)));
    assert.ok(rows.every((row) => row.auth_kind === "client"));
    assert.ok(rows.every((row) => row.method === "GET" && row.path === "/v1/projects" && row.route_key === "/v1/projects"));
    assert.equal(rows[2].error_code, "api_rate_limited");
    assert.equal(rows[2].rate_limited, true);
    assert.ok(rows.every((row) => Number(row.duration_ms) >= 0));

    const metricDenied = await fetch(`${base}/metrics`);
    assert.equal(metricDenied.status, 401);
    const metrics = await fetch(`${base}/metrics`, {
      headers: { authorization: "Bearer observability-metrics-token-32-characters-minimum" },
    });
    assert.equal(metrics.status, 200);
    const text = await metrics.text();
    assert.match(text, /onegl_api_rate_limited_total 1/);
    assert.match(text, /onegl_api_requests_total\{method="GET",route="\/v1\/projects",status="2xx"\} 2/);
    assert.match(text, /onegl_database_ready 1/);
    assert.match(text, /onegl_webhook_events/);
    assert.match(text, /onegl_worker_state\{state="offline"\} 1/);

    const auditTool = runTool("tools/audit-log.js", ["--tenant-id", String(tenant.id), "--hours", "1", "--limit", "10"]);
    assert.ok(auditTool.data.some((row) => requestIds.includes(row.request_id)));

    const summary = runTool("tools/ops-summary.js", ["--tenant-id", String(tenant.id), "--hours", "1"]);
    assert.ok(summary.api.requests >= 3);
    assert.ok(summary.api.rate_limited >= 1);
    assert.ok(summary.api.top_routes.some((row) => row.route_key === "/v1/projects"));

    const columns = (await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'service_api_audit_logs'`,
    )).rows.map((row) => row.column_name);
    assert.ok(!columns.includes("request_body"));
    assert.ok(!columns.includes("response_body"));
    assert.ok(!columns.includes("authorization"));
  } finally {
    if (processInfo) await stop(processInfo.child);
    if (clientName) await pool.query("DELETE FROM service_api_clients WHERE name = $1", [clientName]).catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
});
