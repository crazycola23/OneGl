import IORedis from "ioredis";

/**
 * Redis 连接。
 *
 * 队列是可选的：没有配置 REDIS_URL 时，网页上的「开始监测」会给出提示，
 * 命令行 batch:run 仍然可用，这样本地没有 Redis 也能继续开发。
 */
export function redisUrl() {
  const raw = process.env.REDIS_URL;
  return raw && raw.trim() ? raw.trim() : null;
}

export function isQueueConfigured() {
  return redisUrl() !== null;
}

export function queuePrefix() {
  return process.env.ONEGL_QUEUE_PREFIX ?? "onegl";
}

/** 每个账号一条队列：队列本身串行，天然保证单账号 concurrency = 1。 */
export function accountQueueName(accountKey) {
  return `${queuePrefix()}-run-${accountKey}`;
}

let sharedConnection = null;

export function getRedis() {
  const url = redisUrl();
  if (!url) throw new Error("REDIS_URL 未配置，后台队列不可用。");
  if (!sharedConnection) {
    sharedConnection = new IORedis(url, {
      // BullMQ 的 Worker 要求禁用请求重试，否则阻塞式取任务会被中断
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    // 连接层的错误不能让进程直接退出（Redis 重启时 Worker 应当自行恢复）
    sharedConnection.on("error", (error) => {
      console.error(`[redis] 连接错误：${error.message}`);
    });
  }
  return sharedConnection;
}

export async function closeRedis() {
  if (!sharedConnection) return;
  const connection = sharedConnection;
  sharedConnection = null;
  await connection.quit().catch(() => connection.disconnect());
}

export async function checkRedis() {
  if (!isQueueConfigured()) return { ready: false, message: "REDIS_URL 未配置" };
  try {
    const connection = getRedis();
    await connection.ping();
    return { ready: true, message: "" };
  } catch (error) {
    return { ready: false, message: error.message };
  }
}
