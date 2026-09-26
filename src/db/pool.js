import pg from "pg";

/**
 * PostgreSQL is optional: the collector still works artifact-only when
 * DATABASE_URL is absent, which keeps local runs usable without a server.
 */
export function databaseUrl() {
  const raw = process.env.DATABASE_URL;
  return raw && raw.trim() ? raw.trim() : null;
}

export function isDatabaseConfigured() {
  return databaseUrl() !== null;
}

/**
 * 连接池上限。
 *
 * 2026-09-26 实测：这里原本写死 `max: 4`，而千问匿名面的并发槽位**也是** 4。
 *
 * 要命的地方在于账号租约是**会话级 advisory lock，必须独占一条池连接整整一个 attempt**
 * （最长 900 秒，见 `accounts/distributed-lock.js` 的 `pool.connect()`）。于是 4 个槽位一开满，
 * 池里一条空闲连接都不剩，任何别的查询 —— `accountAvailability`、`refreshBatchProgress`、
 * `discoverAccounts`、引用页分析对账 —— 都只能排队，等满 `connectionTimeoutMillis` 就抛
 * `timeout exceeded when trying to connect`。
 *
 * 这个文案与 ioredis 的报错极像，所以一度被归因成「Redis 长跑后连接失效」，还据此加了
 * worker 定时自重启 —— 方向是错的：当时 Redis 侧完全健康（rejected_connections=0、
 * ping 0.2ms），共享连接和 duplicate 复现都是好的。判定归属的正确证据在 pg 侧：
 * 持锁的那两条连接 idle 上百秒、`pg_stat_activity.query` 正是
 * `SELECT pg_try_advisory_lock($1::bigint)`，而 `idleTimeoutMillis` 只有 10 秒 ——
 * 它们本该被回收却没有，因为它们根本不是「空闲」，是被租约攥着。
 *
 * 余量按「并发槽位 × 平台数 + 后台短查询」给：凭证账号 2 槽、匿名账号 4 槽，
 * 两个平台加起来还要留出周期对账、账号扫描与每次收尾的 refreshBatchProgress。
 * 4 这个数字与并发度相等，等于把「池」和「并发」两件事绑死，是没有余量的写法。
 */
const DEFAULT_POOL_MAX = 16;

/** 下限 4 = 改造前的值，任何覆盖都不该比它更小。 */
export function poolMax() {
  const raw = Number(process.env.ONEGL_DB_POOL_MAX);
  return Number.isInteger(raw) && raw >= 4 ? raw : DEFAULT_POOL_MAX;
}

export { DEFAULT_POOL_MAX };

export function createPool(overrides = {}) {
  const connectionString = databaseUrl();
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set, so PostgreSQL persistence is disabled.");
  }
  return new pg.Pool({
    connectionString,
    max: poolMax(),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    ...overrides,
  });
}
