/**
 * 常驻采集 worker 的账号对账内核。
 *
 * src/worker.js 在 import 阶段就会连 Redis 并进入 main()，没法在单测里被引用，
 * 所以「哪些账号该被停掉」这条判定单独放出来：它必须能在不启动 BullMQ 和浏览器的前提下被驱动。
 */

function staleAccountKeys(trackedKeys, enabledKeys) {
  const enabled = new Set(enabledKeys);
  return [...trackedKeys].filter((identity) => !enabled.has(identity));
}

/**
 * 对账时停掉已不在 enabled 集合里的账号 worker，返回被停掉的 key 列表。
 * 只增不减会让软删账号继续常驻消费自己的队列，带着已回收的登录态去采集。
 *
 * 两侧都是 accountIdentity(accountKey, provider) 的不透明身份串：同一个 account_key 在
 * 两个平台下是两条队列，按平台分开判定才不会停掉一个而连带停掉另一个。
 */
export async function reclaimStaleAccountWorkers(trackedKeys, enabledKeys, stopWorkerFor) {
  const stale = staleAccountKeys(trackedKeys, enabledKeys);
  for (const accountKey of stale) {
    await stopWorkerFor(accountKey);
  }
  return stale;
}
