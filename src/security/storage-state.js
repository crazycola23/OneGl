import crypto from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const FORMAT = "onegl-storage-state";
const VERSION = 1;
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function removeIfExists(path) {
  if (await exists(path)) await unlink(path);
}

function boolValue(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

export function parseStorageStateKey(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  const value = String(raw).trim();
  let key;
  if (value.startsWith("base64:")) {
    key = Buffer.from(value.slice(7), "base64");
  } else if (value.startsWith("base64url:")) {
    key = Buffer.from(value.slice(10), "base64url");
  } else if (value.startsWith("hex:")) {
    const body = value.slice(4);
    if (!/^[0-9a-f]{64}$/i.test(body)) {
      throw new Error("ONEGL_STORAGE_STATE_KEY hex value must contain exactly 64 hex characters");
    }
    key = Buffer.from(body, "hex");
  } else {
    throw new Error(
      "ONEGL_STORAGE_STATE_KEY must use base64:, base64url:, or hex: prefix and decode to 32 bytes",
    );
  }
  if (key.length !== 32) {
    throw new Error("ONEGL_STORAGE_STATE_KEY must decode to exactly 32 bytes for AES-256-GCM");
  }
  return key;
}

export function storageStateKeyId(keyOrRaw) {
  const key = Buffer.isBuffer(keyOrRaw) ? keyOrRaw : parseStorageStateKey(keyOrRaw);
  if (!key || key.length !== 32) throw new Error("storage state key id requires a 32-byte key");
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export function storageStateScope(accountKey = null, provider = "doubao") {
  return `provider=${provider};account=${accountKey ?? "default"}`;
}

function scopeFor(config) {
  return storageStateScope(config.accountKey ?? null, config.provider ?? "doubao");
}

function aadFor(scope) {
  return Buffer.from(`${FORMAT}:v${VERSION}:${scope}`, "utf8");
}

function pathsFor(config) {
  const plaintextPath = config.authStatePlaintextPath ?? config.authStatePath;
  const encryptedPath = config.authStateEncryptedPath ?? `${plaintextPath}.enc`;
  if (!plaintextPath || !encryptedPath) throw new Error("storage state paths are not configured");
  return { plaintextPath, encryptedPath };
}

function legacyPathsFor(config) {
  const plaintextPath = config.authStateLegacyPlaintextPath ?? null;
  if (!plaintextPath) return null;
  return {
    plaintextPath,
    encryptedPath: config.authStateLegacyEncryptedPath ?? `${plaintextPath}.enc`,
  };
}

/**
 * State written before storage state was provider-scoped is still valid for Doubao - the
 * encryption scope string is unchanged - so it is read from the old file name and always
 * rewritten under the provider-scoped one, never back into the legacy name.
 */
async function pathsForLoad(config) {
  const current = pathsFor(config);
  if ((await exists(current.encryptedPath)) || (await exists(current.plaintextPath))) {
    return { ...current, write: current, legacy: false };
  }
  const legacy = legacyPathsFor(config);
  if (legacy && ((await exists(legacy.encryptedPath)) || (await exists(legacy.plaintextPath)))) {
    return { ...legacy, write: current, legacy: true };
  }
  return { ...current, write: current, legacy: false };
}

async function removeLegacyCopies(config) {
  const legacy = legacyPathsFor(config);
  if (!legacy) return;
  await removeIfExists(legacy.encryptedPath);
  await removeIfExists(legacy.plaintextPath);
}

/**
 * Existence has to follow the same legacy fallback as loading does, or an account whose state
 * still sits under the pre-scoping file name is reported as never having logged in - which
 * turns a session expiry into a login requirement and changes how the account is paused.
 */
export async function hasStoredStorageState(config) {
  const { encryptedPath, plaintextPath } = await pathsForLoad(config);
  return (await exists(encryptedPath)) || (await exists(plaintextPath));
}

export function encryptStorageState(state, key, scope) {
  if (!key || key.length !== 32) throw new Error("storage state encryption requires a 32-byte key");
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
  cipher.setAAD(aadFor(scope));
  const plaintext = Buffer.from(JSON.stringify(state), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    format: FORMAT,
    version: VERSION,
    algorithm: ALGORITHM,
    key_id: storageStateKeyId(key),
    scope,
    iv: iv.toString("base64url"),
    tag: tag.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

export function decryptStorageState(envelope, key, expectedScope) {
  if (!envelope || envelope.format !== FORMAT || envelope.version !== VERSION) {
    throw new Error("unsupported or invalid encrypted storage state format");
  }
  if (envelope.algorithm !== ALGORITHM) throw new Error("unsupported storage state encryption algorithm");
  if (envelope.scope !== expectedScope) {
    throw new Error("encrypted storage state belongs to a different account scope");
  }
  if (!key || key.length !== 32) throw new Error("storage state decryption requires a 32-byte key");
  try {
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(envelope.iv, "base64url"),
      { authTagLength: AUTH_TAG_BYTES },
    );
    decipher.setAAD(aadFor(expectedScope));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8"));
  } catch (error) {
    throw new Error("encrypted storage state could not be authenticated or decrypted", { cause: error });
  }
}

async function atomicWrite(path, data) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, data, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function encryptionConfig(config) {
  const rawKey = config.storageStateKey ?? process.env.ONEGL_STORAGE_STATE_KEY ?? null;
  const required =
    config.requireStorageStateEncryption ??
    boolValue(process.env.ONEGL_REQUIRE_STORAGE_STATE_ENCRYPTION, false);
  const key = parseStorageStateKey(rawKey);
  if (required && !key) {
    throw new Error(
      "storage state encryption is required but ONEGL_STORAGE_STATE_KEY is not configured",
    );
  }
  return { key, required };
}

export function assertStorageStateEncryptionReady(config = {}) {
  return encryptionConfig(config);
}

export function storageStateEncryptionStatus(config = {}) {
  const rawKey = config.storageStateKey ?? process.env.ONEGL_STORAGE_STATE_KEY ?? null;
  const required =
    config.requireStorageStateEncryption ??
    boolValue(process.env.ONEGL_REQUIRE_STORAGE_STATE_ENCRYPTION, false);
  let configured = false;
  let valid = true;
  try {
    configured = Boolean(parseStorageStateKey(rawKey));
  } catch {
    configured = Boolean(rawKey);
    valid = false;
  }
  return { configured, required, valid, algorithm: ALGORITHM };
}

export async function loadStoredStorageState(config) {
  const { plaintextPath, encryptedPath, write, legacy } = await pathsForLoad(config);
  const scope = scopeFor(config);
  const { key, required } = encryptionConfig(config);

  if (await exists(encryptedPath)) {
    if (!key) {
      throw new Error(
        `encrypted storage state exists at ${encryptedPath}, but ONEGL_STORAGE_STATE_KEY is not configured`,
      );
    }
    const envelope = JSON.parse(await readFile(encryptedPath, "utf8"));
    const state = decryptStorageState(envelope, key, scope);
    await removeIfExists(plaintextPath);
    if (legacy) {
      // Re-key the envelope under the scoped name so the legacy file does not linger as a
      // second live copy of the same credentials.
      await atomicWrite(write.encryptedPath, `${JSON.stringify(encryptStorageState(state, key, scope))}\n`);
      await removeLegacyCopies(config);
    }
    return {
      present: true,
      encrypted: true,
      migrated: false,
      legacy,
      state,
      path: legacy ? write.encryptedPath : encryptedPath,
    };
  }

  if (!(await exists(plaintextPath))) {
    return {
      present: false,
      encrypted: Boolean(key),
      migrated: false,
      legacy: false,
      state: null,
      path: key ? write.encryptedPath : write.plaintextPath,
    };
  }

  if (required && !key) {
    throw new Error("plaintext storage state is present but encryption is required");
  }

  const state = JSON.parse(await readFile(plaintextPath, "utf8"));
  if (!key) {
    await chmod(plaintextPath, 0o600);
    return {
      present: true,
      encrypted: false,
      migrated: false,
      legacy,
      state,
      path: plaintextPath,
    };
  }

  await atomicWrite(write.encryptedPath, `${JSON.stringify(encryptStorageState(state, key, scope))}\n`);
  await removeIfExists(plaintextPath);
  await removeLegacyCopies(config);
  return {
    present: true,
    encrypted: true,
    migrated: true,
    legacy,
    state,
    path: write.encryptedPath,
  };
}

export async function saveStoredStorageState(config, state) {
  const { plaintextPath, encryptedPath } = pathsFor(config);
  const scope = scopeFor(config);
  const { key } = encryptionConfig(config);

  if (key) {
    const envelope = encryptStorageState(state, key, scope);
    await atomicWrite(encryptedPath, `${JSON.stringify(envelope)}\n`);
    await removeIfExists(plaintextPath);
    await removeLegacyCopies(config);
    return { encrypted: true, path: encryptedPath };
  }

  if (await exists(encryptedPath)) {
    throw new Error(
      `refusing to downgrade encrypted storage state at ${encryptedPath} to plaintext without ONEGL_STORAGE_STATE_KEY`,
    );
  }
  await atomicWrite(plaintextPath, `${JSON.stringify(state)}\n`);
  await removeLegacyCopies(config);
  return { encrypted: false, path: plaintextPath };
}

export async function rotateEncryptedStorageStateFile({
  encryptedPath,
  accountKey = null,
  provider = "doubao",
  oldKey: oldKeyRaw,
  newKey: newKeyRaw,
  dryRun = false,
}) {
  const oldKey = parseStorageStateKey(oldKeyRaw);
  const newKey = parseStorageStateKey(newKeyRaw);
  if (!oldKey || !newKey) throw new Error("storage state rotation requires both old and new keys");
  const oldKeyId = storageStateKeyId(oldKey);
  const newKeyId = storageStateKeyId(newKey);
  if (oldKeyId === newKeyId) throw new Error("old and new storage state keys are identical");

  const envelope = JSON.parse(await readFile(encryptedPath, "utf8"));
  const scope = storageStateScope(accountKey, provider);
  if (envelope.key_id === newKeyId) {
    decryptStorageState(envelope, newKey, scope);
    return {
      path: encryptedPath,
      scope,
      old_key_id: oldKeyId,
      new_key_id: newKeyId,
      rotated: false,
      already_rotated: true,
    };
  }

  const state = decryptStorageState(envelope, oldKey, scope);
  if (!dryRun) {
    const nextEnvelope = encryptStorageState(state, newKey, scope);
    await atomicWrite(encryptedPath, `${JSON.stringify(nextEnvelope)}\n`);
  }
  return {
    path: encryptedPath,
    scope,
    old_key_id: oldKeyId,
    new_key_id: newKeyId,
    rotated: !dryRun,
    already_rotated: false,
  };
}
