import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import {
  assertStorageStateEncryptionReady,
  decryptStorageState,
  encryptStorageState,
  loadStoredStorageState,
  parseStorageStateKey,
  saveStoredStorageState,
  storageStateEncryptionStatus,
} from "../src/security/storage-state.js";

const KEY_A = `base64:${Buffer.alloc(32, 0x11).toString("base64")}`;
const KEY_B = `base64:${Buffer.alloc(32, 0x22).toString("base64")}`;
const SAMPLE_STATE = {
  cookies: [
    {
      name: "sessionid",
      value: "super-secret-cookie-value",
      domain: ".doubao.com",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ],
  origins: [],
};

function configFor(root, { accountKey = "account_a", key = KEY_A, required = false } = {}) {
  const plaintext = path.join(root, "auth", "accounts", `${accountKey}.storage.json`);
  return {
    accountKey,
    authStatePlaintextPath: plaintext,
    authStateEncryptedPath: `${plaintext}.enc`,
    authStatePath: key ? `${plaintext}.enc` : plaintext,
    storageStateKey: key,
    requireStorageStateEncryption: required,
  };
}

test("config exposes encrypted auth path when a key is present", () => {
  const config = loadConfig({
    dataDir: "/tmp/onegl-test-data",
    accountKey: "account_a",
    storageStateKey: KEY_A,
  });
  assert.match(config.authStatePlaintextPath, /doubao__account_a\.storage\.json$/);
  assert.match(config.authStateEncryptedPath, /doubao__account_a\.storage\.json\.enc$/);
  assert.equal(config.authStatePath, config.authStateEncryptedPath);
});

test("storage state is scoped per provider so one account key cannot span platforms", () => {
  const doubao = loadConfig({ dataDir: "/tmp/onegl-test-data", accountKey: "account_a" });
  const kimi = loadConfig({ dataDir: "/tmp/onegl-test-data", accountKey: "account_a", provider: "kimi" });

  assert.equal(doubao.provider, "doubao");
  assert.equal(kimi.provider, "kimi");
  assert.notEqual(doubao.authStatePlaintextPath, kimi.authStatePlaintextPath);
  assert.notEqual(doubao.authStateEncryptedPath, kimi.authStateEncryptedPath);
  // Doubao predates provider scoping, so its legacy file name must still resolve; a second
  // platform must never inherit that fallback.
  assert.match(doubao.authStateLegacyPlaintextPath, /[/\\]account_a\.storage\.json$/);
  assert.equal(kimi.authStateLegacyPlaintextPath, null);
  assert.throws(() => loadConfig({ accountKey: "account_a", provider: "../etc" }), /is invalid/);
});

test("AES-GCM storage state is authenticated and account-bound", () => {
  const keyA = parseStorageStateKey(KEY_A);
  const keyB = parseStorageStateKey(KEY_B);
  const scope = "provider=doubao;account=account_a";
  const envelope = encryptStorageState(SAMPLE_STATE, keyA, scope);

  assert.deepEqual(decryptStorageState(envelope, keyA, scope), SAMPLE_STATE);
  assert.throws(
    () => decryptStorageState(envelope, keyB, scope),
    /authenticated or decrypted/,
  );
  assert.throws(
    () => decryptStorageState(envelope, keyA, "provider=doubao;account=account_b"),
    /different account scope/,
  );
  assert.equal(envelope.ciphertext.includes("super-secret-cookie-value"), false);
});

test("legacy plaintext state is migrated once and plaintext is removed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "onegl-storage-state-"));
  try {
    const config = configFor(root);
    await mkdir(path.dirname(config.authStatePlaintextPath), { recursive: true });
    await writeFile(config.authStatePlaintextPath, JSON.stringify(SAMPLE_STATE));

    const loaded = await loadStoredStorageState(config);
    assert.equal(loaded.present, true);
    assert.equal(loaded.encrypted, true);
    assert.equal(loaded.migrated, true);
    assert.deepEqual(loaded.state, SAMPLE_STATE);

    await assert.rejects(readFile(config.authStatePlaintextPath, "utf8"), /ENOENT/);
    const encryptedText = await readFile(config.authStateEncryptedPath, "utf8");
    assert.equal(encryptedText.includes("super-secret-cookie-value"), false);
    assert.equal((await stat(config.authStateEncryptedPath)).mode & 0o777, 0o600);

    const second = await loadStoredStorageState(config);
    assert.equal(second.migrated, false);
    assert.deepEqual(second.state, SAMPLE_STATE);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("save writes only encrypted state when a key is configured", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "onegl-storage-state-save-"));
  try {
    const config = configFor(root);
    const saved = await saveStoredStorageState(config, SAMPLE_STATE);
    assert.equal(saved.encrypted, true);
    assert.equal(saved.path, config.authStateEncryptedPath);
    await assert.rejects(readFile(config.authStatePlaintextPath, "utf8"), /ENOENT/);
    assert.deepEqual((await loadStoredStorageState(config)).state, SAMPLE_STATE);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("encrypted state never downgrades to plaintext when the key is missing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "onegl-storage-state-downgrade-"));
  try {
    const encryptedConfig = configFor(root);
    await saveStoredStorageState(encryptedConfig, SAMPLE_STATE);

    const noKeyConfig = configFor(root, { key: null });
    await assert.rejects(
      () => loadStoredStorageState(noKeyConfig),
      /ONEGL_STORAGE_STATE_KEY is not configured/,
    );
    await assert.rejects(
      () => saveStoredStorageState(noKeyConfig, SAMPLE_STATE),
      /refusing to downgrade encrypted storage state/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("required encryption fails closed before browser use", () => {
  const config = { storageStateKey: null, requireStorageStateEncryption: true };
  assert.throws(
    () => assertStorageStateEncryptionReady(config),
    /encryption is required/,
  );
  assert.deepEqual(storageStateEncryptionStatus(config), {
    configured: false,
    required: true,
    valid: true,
    algorithm: "aes-256-gcm",
  });
  assert.throws(() => parseStorageStateKey("base64:too-short"), /exactly 32 bytes/);
});

test("providers sharing an account key keep independent login state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "onegl-storage-provider-"));
  try {
    const base = { dataDir: root, accountKey: "account_a", storageStateKey: KEY_A };
    const doubao = loadConfig(base);
    const kimi = loadConfig({ ...base, provider: "kimi" });
    const kimiState = { ...SAMPLE_STATE, cookies: [{ ...SAMPLE_STATE.cookies[0], value: "kimi-cookie" }] };

    await saveStoredStorageState(doubao, SAMPLE_STATE);
    await saveStoredStorageState(kimi, kimiState);

    // A second platform logging in must not displace the first platform's session - the two
    // files used to resolve to the same path, which silently logged the account out of Doubao.
    assert.deepEqual((await loadStoredStorageState(doubao)).state, SAMPLE_STATE);
    assert.deepEqual((await loadStoredStorageState(kimi)).state, kimiState);

    const foreign = JSON.parse(await readFile(kimi.authStateEncryptedPath, "utf8"));
    assert.equal(foreign.scope, "provider=kimi;account=account_a");
    assert.throws(
      () => decryptStorageState(foreign, KEY_A, "provider=doubao;account=account_a"),
      /different account scope/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy Doubao state is read from the unscoped name and moved to the scoped one", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "onegl-storage-legacy-"));
  try {
    const config = loadConfig({ dataDir: root, accountKey: "account_a", storageStateKey: KEY_A });
    const legacyPlaintext = config.authStateLegacyPlaintextPath;
    await mkdir(path.dirname(legacyPlaintext), { recursive: true });
    await writeFile(legacyPlaintext, JSON.stringify(SAMPLE_STATE));

    const loaded = await loadStoredStorageState(config);
    assert.equal(loaded.present, true);
    assert.equal(loaded.legacy, true);
    assert.deepEqual(loaded.state, SAMPLE_STATE);
    assert.equal(loaded.path, config.authStateEncryptedPath);

    await assert.rejects(readFile(legacyPlaintext, "utf8"), /ENOENT/);
    assert.equal(
      JSON.parse(await readFile(config.authStateEncryptedPath, "utf8")).scope,
      "provider=doubao;account=account_a",
    );
    // Reading must not leave a second live copy of the credentials behind under either name.
    await assert.rejects(readFile(config.authStateLegacyEncryptedPath, "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
