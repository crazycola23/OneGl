import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadStoredStorageState,
  rotateEncryptedStorageStateFile,
  saveStoredStorageState,
  storageStateKeyId,
} from "../src/security/storage-state.js";
import {
  assertProductionSafety,
  isProductionRuntime,
  staticSafetyReport,
} from "../src/system/readiness.js";

const OLD_KEY = `base64:${Buffer.alloc(32, 0x31).toString("base64")}`;
const NEW_KEY = `base64:${Buffer.alloc(32, 0x42).toString("base64")}`;

function productionEnv(overrides = {}) {
  return {
    ONEGL_PRODUCTION: "true",
    DATABASE_URL: "postgresql://example.invalid/onegl",
    REDIS_URL: "redis://example.invalid:6379",
    ONEGL_STORAGE_STATE_KEY: NEW_KEY,
    ONEGL_REQUIRE_STORAGE_STATE_ENCRYPTION: "true",
    ONEGL_WEBHOOK_SIGNING_KEY: "w".repeat(48),
    ONEGL_WEBHOOK_ALLOW_HTTP: "false",
    ...overrides,
  };
}

test("production runtime detection accepts explicit flag and NODE_ENV", () => {
  assert.equal(isProductionRuntime({ ONEGL_PRODUCTION: "true" }), true);
  assert.equal(isProductionRuntime({ NODE_ENV: "production" }), true);
  assert.equal(isProductionRuntime({ NODE_ENV: "test" }), false);
});

test("production API safety requires DB, queue, enforced storage encryption and webhook signing", () => {
  const ready = staticSafetyReport({ role: "api", env: productionEnv() });
  assert.equal(ready.ready, true);
  assert.equal(ready.checks.storage_state_encryption.ready, true);
  assert.equal(ready.checks.webhook_signing.ready, true);

  const missingStorage = staticSafetyReport({
    role: "api",
    env: productionEnv({ ONEGL_STORAGE_STATE_KEY: "", ONEGL_REQUIRE_STORAGE_STATE_ENCRYPTION: "false" }),
  });
  assert.equal(missingStorage.ready, false);
  assert.equal(missingStorage.checks.storage_state_encryption.ready, false);

  const httpWebhook = staticSafetyReport({
    role: "api",
    env: productionEnv({ ONEGL_WEBHOOK_ALLOW_HTTP: "true" }),
  });
  assert.equal(httpWebhook.ready, false);
  assert.equal(httpWebhook.checks.webhook_https_only.ready, false);
});

test("production role requirements differ by process responsibility", () => {
  const webhook = staticSafetyReport({
    role: "webhook",
    env: productionEnv({ REDIS_URL: "", ONEGL_STORAGE_STATE_KEY: "", ONEGL_REQUIRE_STORAGE_STATE_ENCRYPTION: "false" }),
  });
  assert.equal(webhook.ready, true);
  assert.equal(webhook.checks.queue_configured.required, false);
  assert.equal(webhook.checks.storage_state_encryption.required, false);

  assert.throws(
    () => assertProductionSafety({ role: "worker", env: productionEnv({ REDIS_URL: "" }) }),
    /queue_configured/,
  );
});

test("storageState rotation is authenticated, dry-runnable and recoverable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "onegl-rotate-"));
  try {
    const accountKey = "account_a";
    const plaintext = path.join(root, "auth", "accounts", `${accountKey}.storage.json`);
    const encryptedPath = `${plaintext}.enc`;
    const state = {
      cookies: [{ name: "sid", value: "secret", domain: ".doubao.com", path: "/" }],
      origins: [],
    };
    const oldConfig = {
      accountKey,
      authStatePlaintextPath: plaintext,
      authStateEncryptedPath: encryptedPath,
      authStatePath: encryptedPath,
      storageStateKey: OLD_KEY,
      requireStorageStateEncryption: true,
    };
    await saveStoredStorageState(oldConfig, state);

    const before = JSON.parse(await readFile(encryptedPath, "utf8"));
    assert.equal(before.key_id, storageStateKeyId(OLD_KEY));

    const dryRun = await rotateEncryptedStorageStateFile({
      encryptedPath,
      accountKey,
      oldKey: OLD_KEY,
      newKey: NEW_KEY,
      dryRun: true,
    });
    assert.equal(dryRun.rotated, false);
    assert.equal(JSON.parse(await readFile(encryptedPath, "utf8")).key_id, storageStateKeyId(OLD_KEY));

    const rotated = await rotateEncryptedStorageStateFile({
      encryptedPath,
      accountKey,
      oldKey: OLD_KEY,
      newKey: NEW_KEY,
    });
    assert.equal(rotated.rotated, true);
    assert.equal(JSON.parse(await readFile(encryptedPath, "utf8")).key_id, storageStateKeyId(NEW_KEY));

    const newConfig = { ...oldConfig, storageStateKey: NEW_KEY };
    assert.deepEqual((await loadStoredStorageState(newConfig)).state, state);

    const rerun = await rotateEncryptedStorageStateFile({
      encryptedPath,
      accountKey,
      oldKey: OLD_KEY,
      newKey: NEW_KEY,
    });
    assert.equal(rerun.already_rotated, true);
    assert.equal(rerun.rotated, false);

    await assert.rejects(() => loadStoredStorageState(oldConfig), /authenticated or decrypted/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
