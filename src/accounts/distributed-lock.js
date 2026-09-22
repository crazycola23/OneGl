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
 */
export async function acquireAccountExecutionLease(pool, { accountKey, provider = "doubao", parallelism = 1 }) {
  const slots = Math.max(1, Math.floor(Number(parallelism) || 1));
  const client = await pool.connect();
  // The account identity in PostgreSQL is (provider, account_key); the lock has to match it
  // or one platform's serialization would freeze the same key on every other platform.
  const accountLockKey = advisoryKey("onegl-account", `${provider}:${accountKey}`);
  let slotLockKey = null;
  let released = false;

  try {
    if (!await tryLock(client, accountLockKey)) {
      client.release();
      return null;
    }

    for (let slot = 0; slot < slots; slot += 1) {
      const candidate = advisoryKey("onegl-global-slot", slot);
      if (await tryLock(client, candidate)) {
        slotLockKey = candidate;
        break;
      }
    }

    if (!slotLockKey) {
      await unlock(client, accountLockKey);
      client.release();
      return null;
    }

    return {
      accountKey,
      async release() {
        if (released) return;
        released = true;
        await unlock(client, slotLockKey);
        await unlock(client, accountLockKey);
        client.release();
      },
    };
  } catch (error) {
    if (slotLockKey) await unlock(client, slotLockKey);
    await unlock(client, accountLockKey);
    client.release();
    throw error;
  }
}
