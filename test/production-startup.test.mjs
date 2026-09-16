import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

async function runEntry(entry, env) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [entry], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test("production API startup fails before listening when safety configuration is incomplete", async () => {
  const result = await runEntry("src/api-entry.js", {
    NODE_ENV: "production",
    ONEGL_PRODUCTION: "true",
    DATABASE_URL: "postgresql://configured-but-not-used.invalid/onegl",
    REDIS_URL: "redis://configured-but-not-used.invalid:6379",
    ONEGL_STORAGE_STATE_KEY: "",
    ONEGL_REQUIRE_STORAGE_STATE_ENCRYPTION: "false",
    ONEGL_WEBHOOK_SIGNING_KEY: "short",
    ONEGL_WEBHOOK_ALLOW_HTTP: "true",
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /production safety check failed/);
  assert.match(result.stderr, /storage_state_encryption/);
  assert.match(result.stderr, /webhook_signing/);
  assert.match(result.stderr, /webhook_https_only/);
  assert.doesNotMatch(result.stdout, /OneGl Service API:/);
});

test("production worker startup rejects missing queue configuration before importing BullMQ worker", async () => {
  const key = `base64:${Buffer.alloc(32, 0x52).toString("base64")}`;
  const result = await runEntry("src/worker-entry.js", {
    NODE_ENV: "production",
    ONEGL_PRODUCTION: "true",
    DATABASE_URL: "postgresql://configured-but-not-used.invalid/onegl",
    REDIS_URL: "",
    ONEGL_STORAGE_STATE_KEY: key,
    ONEGL_REQUIRE_STORAGE_STATE_ENCRYPTION: "true",
    ONEGL_WEBHOOK_ALLOW_HTTP: "false",
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /production safety check failed/);
  assert.match(result.stderr, /queue_configured/);
});
