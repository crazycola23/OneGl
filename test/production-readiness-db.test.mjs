import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

const enabled = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);

function startApi(port) {
  const storageKey = `base64:${Buffer.alloc(32, 0x71).toString("base64")}`;
  const child = spawn(process.execPath, ["src/api-entry.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      ONEGL_PRODUCTION: "true",
      ONEGL_API_HOST: "127.0.0.1",
      ONEGL_API_PORT: String(port),
      ONEGL_API_KEY: "production-readiness-test-master-key",
      ONEGL_STORAGE_STATE_KEY: storageKey,
      ONEGL_REQUIRE_STORAGE_STATE_ENCRYPTION: "true",
      ONEGL_WEBHOOK_SIGNING_KEY: "s".repeat(48),
      ONEGL_WEBHOOK_ALLOW_HTTP: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  return { child, output: () => ({ stdout, stderr }) };
}

async function waitListening(info, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const output = info.output();
    if (output.stdout.includes("OneGl Service API:")) return;
    if (info.child.exitCode !== null) {
      throw new Error(`API exited early (${info.child.exitCode})\n${output.stdout}\n${output.stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const output = info.output();
  throw new Error(`API did not listen\n${output.stdout}\n${output.stderr}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

test("production API reports ready only with live DB, applied migrations, Redis and safety controls", { skip: !enabled }, async () => {
  const port = 35000 + (process.pid % 1000);
  const info = startApi(port);
  try {
    await waitListening(info);
    const response = await fetch(`http://127.0.0.1:${port}/readyz`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "ready");
    assert.equal(body.ready, true);
    assert.equal(body.production, true);
    assert.equal(body.checks.database.ready, true);
    assert.equal(body.checks.migrations.ready, true);
    assert.equal(body.checks.migrations.pending.length, 0);
    assert.equal(body.checks.queue.ready, true);
    assert.equal(body.checks.storage_state_encryption.ready, true);
    assert.equal(body.checks.webhook_signing.ready, true);
    assert.equal(body.checks.webhook_https_only.ready, true);
  } finally {
    await stop(info.child);
  }
});
