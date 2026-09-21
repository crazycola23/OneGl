import { stat, unlink } from "node:fs/promises";
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

export function accountStorageStatePaths(dataDir, accountKey) {
  const plaintextPath = accountStatePath(dataDir, accountKey);
  // 密文文件名沿用 config.js 的规则：明文路径加 .enc 后缀，即 <account_key>.storage.json.enc。
  return [plaintextPath, `${plaintextPath}.enc`];
}

/** 删除账号在磁盘上的登录态；文件名一律由 account_key 派生，缺失文件不算错误。 */
export async function removeAccountStorageStates(dataDir, accountKey) {
  const key = normalizeAccountKey(accountKey);
  const directory = path.resolve(accountAuthDir(dataDir));
  const removed = [];
  for (const candidate of accountStorageStatePaths(dataDir, key)) {
    // 目录穿越兜底：目标必须落在 accounts 目录的直接子层，绝不接受任何输入把删除带出目录。
    if (path.dirname(path.resolve(candidate)) !== directory) {
      throw new Error(`拒绝删除账号目录之外的登录态：${candidate}`);
    }
    try {
      await unlink(candidate);
      removed.push(candidate);
    } catch (error) {
      // ENOENT 是常态（明文/密文只会存在一种），其余错误也不应阻断软删。
      if (error?.code !== "ENOENT") {
        console.warn(`[accounts] 登录态清理跳过 ${path.basename(candidate)}：${error?.message ?? error}`);
      }
    }
  }
  return removed;
}
