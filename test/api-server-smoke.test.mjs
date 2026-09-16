import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

function startApiProcess(port) {
  const child = spawn(process.execPath, ["src/api-server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ONEGL_API_HOST: "127.0.0.1",
      ONEGL_API_PORT: String(port),
      ONEGL_API_KEY: "test-service-key",
      DATABASE_URL: "",
      REDIS_URL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  return { child, output: () => ({ stdout, stderr }) };
}

async function waitUntilReady(processInfo, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { stdout, stderr } = processInfo.output();
    if (stdout.includes("OneGl Service API:")) return;
    if (processInfo.child.exitCode !== null) {
      throw new Error(`API process exited early (${processInfo.child.exitCode})\n${stdout}\n${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const { stdout, stderr } = processInfo.output();
  throw new Error(`API process did not become ready\n${stdout}\n${stderr}`);
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 3_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

test("api:serve exposes health/OpenAPI and protects v1 routes", async () => {
  const port = 33000 + (process.pid % 1000);
  const processInfo = startApiProcess(port);
  try {
    await waitUntilReady(processInfo);
    const base = `http://127.0.0.1:${port}`;

    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.service, "onegl-api");
    assert.equal(healthBody.database.ready, false);
    assert.equal(healthBody.auth.master_configured, true);
    assert.equal(healthBody.auth.client_keys_supported, true);
    assert.equal(healthBody.remote_auth.enabled, true);

    const spec = await fetch(`${base}/openapi.json`);
    assert.equal(spec.status, 200);
    const specBody = await spec.json();
    assert.equal(specBody.openapi, "3.1.0");
    assert.equal(specBody.info.version, "0.5.0");
    assert.ok(specBody.paths["/v1/tasks"]);
    assert.ok(specBody.paths["/v1/tasks/{taskId}/executions"]);
    assert.ok(specBody.paths["/v1/executions/{executionId}"]);
    assert.ok(specBody.paths["/v1/results/{resultId}"]);
    assert.ok(specBody.paths["/v1/reports/{reportId}"]);
    assert.ok(specBody.paths["/v1/tasks/{taskId}/schedules"]);
    assert.ok(specBody.paths["/v1/batches"]);
    assert.ok(specBody.paths["/v1/admin/tenants"]);
    assert.ok(specBody.paths["/v1/projects/{projectId}/monitor-plans"]);
    assert.ok(specBody.paths["/v1/projects/{projectId}/intelligence"]);

    const anonymous = await fetch(`${base}/v1/projects`);
    assert.equal(anonymous.status, 503);
    const anonymousBody = await anonymous.json();
    assert.equal(anonymousBody.error, "database_unavailable");

    const authenticated = await fetch(`${base}/v1/projects`, {
      headers: { authorization: "Bearer test-service-key" },
    });
    assert.equal(authenticated.status, 503);
    const unavailable = await authenticated.json();
    assert.equal(unavailable.error, "database_unavailable");
  } finally {
    await stopProcess(processInfo.child);
  }
});
