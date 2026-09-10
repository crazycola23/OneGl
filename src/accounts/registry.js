import { stat } from "node:fs/promises";
import path from "node:path";

/**
 * Account / browser-profile bookkeeping.
 *
 * An account is identified by an anonymous key such as account_01. Its Doubao
 * credentials live only in an on-disk Playwright storageState file, one per account so
 * the profiles stay independent:
 *
 *   .onegl/auth/accounts/account_01.storage.json
 *
 * Only the key is ever written to PostgreSQL.
 */

const ACCOUNT_KEY_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export function normalizeAccountKey(value) {
  const key = String(value ?? "").trim();
  if (!ACCOUNT_KEY_PATTERN.test(key)) {
    throw new Error(
      `账号标识不合法：${JSON.stringify(key)}；应形如 account_01，只允许字母、数字、点、下划线和短横线，长度 1-64`,
    );
  }
  return key;
}

export function parseAccountKeys(value) {
  const raw = Array.isArray(value) ? value : String(value ?? "").split(",");
  const keys = raw
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .map(normalizeAccountKey);
  return [...new Set(keys)];
}

export function accountAuthDir(dataDir) {
  return path.join(dataDir, "auth", "accounts");
}

export function accountStatePath(dataDir, accountKey) {
  return path.join(accountAuthDir(dataDir), `${normalizeAccountKey(accountKey)}.storage.json`);
}

export async function hasStoredState(dataDir, accountKey) {
  try {
    await stat(accountStatePath(dataDir, accountKey));
    return true;
  } catch {
    return false;
  }
}
