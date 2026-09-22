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

/**
 * 每个 (平台, 账号) 一条队列：队列本身串行，天然保证单账号 concurrency = 1。
 *
 * 平台必须在名字里。账号身份在数据库里是 (provider, account_key)，同一个 account_key
 * 在两个平台下是两份互不相干的登录态；共用一条队列就等于让它们排同一个串行通道，
 * 一个平台的冷却会把另一个平台一起冻住。
 */
export function accountQueueName(accountKey, provider = "doubao") {
  return `${queuePrefix()}-run-${provider}-${accountKey}`;
}

/**
 * worker 内部按这个键索引会话与 BullMQ Worker。
 * ':' 不在 account_key 允许的字符集（[A-Za-z0-9._-]）里，也不在 provider id 里，所以无歧义。
 */
export function accountIdentity(accountKey, provider = "doubao") {
  return `${provider}:${accountKey}`;
}

/** accountIdentity 的反向操作。缺分隔符说明键不是身份串，静默按豆包处理会停错平台的 worker。 */
export function parseAccountIdentity(identity) {
  const text = String(identity ?? "");
  const index = text.indexOf(":");
  if (index <= 0 || index === text.length - 1) {
    throw new Error(`账号身份串不合法：${JSON.stringify(identity)}`);
  }
  return { provider: text.slice(0, index), accountKey: text.slice(index + 1) };
}

/**
 * 引用页内容分析使用独立队列，不能占用账号采集队列。
 * 这里不按账号拆分：抓第三方公开网页与豆包登录会话是两条完全独立的资源链。
 */
export function sourceIntelligenceQueueName() {
  return `${queuePrefix()}-source-intelligence`;
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
