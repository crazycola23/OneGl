import crypto from "node:crypto";

function advisoryKey(namespace, value) {
  const digest = crypto.createHash("sha256").update(`${namespace}:${value}`).digest();
  return digest.readBigInt64BE(0).toString();
}

async function tryLock(client, key) {
  const { rows } = await client.query("SELECT pg_try_advisory_lock($1::bigint) AS locked", [key]);
  return Boolean(rows[0]?.locked);
}

async function unlock(client, key) {
  await client.query("SELECT pg_advisory_unlock($1::bigint)", [key]).catch(() => undefined);
}

/**
 * Hold a PostgreSQL session advisory lock for one account plus one global execution slot.
 * Locks live on a dedicated pooled connection and are automatically released by PostgreSQL
 * if the worker process/connection dies.
 *
 * **账号锁在 slots > 1 时按槽位放行**（`onegl-account:<provider>:<accountKey>#<slot>`）。
 *
 * 这是刻意的取舍，不是疏漏。账号锁原本的设计意图写在它出现的地方：防止**同一个登录态被并发
 * 击穿** —— 平台看到同一账号多设备同时提问，风控会收紧。所以：
 *
 *   - `slots = 1`（默认）：行为与改造前完全一致，账号锁串行化整个账号，保护完好。
 *   - `slots > 1`：每个槽位各自持锁，同一账号可以真正并行多个浏览器。保护让位给吞吐。
 *     匿名面没有可被击穿的登录态，这个代价为零；有凭证的账号则是在用风控风险换速度。
 *
 * 全局槽位的**数量**要按并发上限给足：只拿一个槽位的话，即便账号锁让开了，第二次 acquire
 * 也拿不到槽位而返回 null，并发仍然停在 1。所以 slots > 1 时槽位计到 parallelism 个。
 */
export async function acquireAccountExecutionLease(
  pool,
  { accountKey, provider = "doubao", parallelism = 1, slot = 0 },
) {
  const slots = Math.max(1, Math.floor(Number(parallelism) || 1));
  const slotIndex = Number.isInteger(slot) && slot > 0 ? slot : 0;
  // slots > 1 才给足全局槽位；否则维持原来的「1 个槽位 + 账号锁互斥」。
  const slotCeiling = slots > 1 ? slots : 1;
  const client = await pool.connect();
  // The account identity in PostgreSQL is (provider, account_key); the lock has to match it
  // or one platform's serialization would freeze the same key on every other platform.
  // 槽位后缀让同一账号的不同槽位互不阻塞，同时仍然保持「同一槽位不被重入」。
  const lockScope = slotIndex > 0 ? `${provider}:${accountKey}#${slotIndex}` : `${provider}:${accountKey}`;
  const accountLockKey = advisoryKey("onegl-account", lockScope);
  let accountLockKeyHeld = null;
  let slotLockKey = null;
  let released = false;

  try {
    // 账号锁始终要拿：slots = 1 时它串行化整个账号；slots > 1 时锁的 scope 带槽位后缀，
    // 同一账号的不同槽位互不阻塞，但仍保证「同一槽位不会被重入」。
    if (!await tryLock(client, accountLockKey)) {
      client.release();
      return null;
    }
    accountLockKeyHeld = accountLockKey;

    for (let candidateSlot = 0; candidateSlot < slotCeiling; candidateSlot += 1) {
      // 全局槽位按**平台**分命名空间：`onegl-global-slot:qianwen:0` 与
      // `onegl-global-slot:doubao:0` 是两把不同的锁。
      //
      // 之前两个平台共用 `onegl-global-slot:<n>`，而槽位总数只由 accountSlots 决定 ——
      // 于是千问和豆包在同一个小池子里互相挤占：为了让豆包不被饿死把槽位加到 4，
      // 代价就是千问不再独占，实测出现过 6.5 分钟一条都没完成的空转段。
      //
      // 分开之后每个平台各自拿到 accountSlots 个槽位，互不干扰。
      // 代价是失去了「跨平台总并发上限」这层保护 —— 这是明确的取舍：
      // 需要限总并发时应当由各平台的 accountSlots 各自约束，而不是让它们互相排队。
      const candidate = advisoryKey("onegl-global-slot", `${provider}:${candidateSlot}`);
      if (await tryLock(client, candidate)) {
        slotLockKey = candidate;
        break;
      }
    }

    if (!slotLockKey) {
      if (accountLockKeyHeld) await unlock(client, accountLockKeyHeld);
      client.release();
      return null;
    }

    return {
      accountKey,
      async release() {
        if (released) return;
        released = true;
        await unlock(client, slotLockKey);
        if (accountLockKeyHeld) await unlock(client, accountLockKeyHeld);
        client.release();
      },
    };
  } catch (error) {
    if (slotLockKey) await unlock(client, slotLockKey);
    if (accountLockKeyHeld) await unlock(client, accountLockKeyHeld);
    client.release();
    throw error;
  }
}
