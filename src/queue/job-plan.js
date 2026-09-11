import { AVAILABILITY } from "../accounts/safety.js";

/**
 * 「账号当前不可用」时这个任务该怎么办。
 *
 * 这是纯逻辑，便于离线验证；Worker 只负责执行返回的动作。
 *
 * 关键区别：
 *   临时（冷却 / 频率限制 / 当日额度用完）-> delay 到 retryAt 再跑，任务不能丢
 *   永久、人工阻塞（禁用 / 登录失效 / 验证码 / 访问受限 / 人工暂停）-> skip，并停止撞账号
 *
 * 冷却不消耗队列重试次数，因此需要一个等待次数上限，避免账号长期不可用时
 * 任务被无限期地推迟下去；超过上限就按跳过处理并把原因写清楚。
 */

export const DEFAULT_MAX_COOLDOWN_WAITS = 3;

export function planUnavailableJob({
  availability,
  cooldownWaits = 0,
  maxCooldownWaits = DEFAULT_MAX_COOLDOWN_WAITS,
  now = Date.now(),
}) {
  const reason = availability?.reason ?? "账号当前不可用";

  if (availability?.kind === AVAILABILITY.TEMPORARY && availability.retryAt) {
    if (cooldownWaits < maxCooldownWaits) {
      return {
        action: "delay",
        // 至少推迟 1 秒，避免冷却恰好在此时结束导致空转。
        retryAt: Math.max(new Date(availability.retryAt).getTime(), now + 1_000),
        cooldownWaits: cooldownWaits + 1,
        reason,
        exhausted: false,
      };
    }
    return { action: "skip", reason, exhausted: true, cooldownWaits };
  }

  return { action: "skip", reason, exhausted: false, cooldownWaits };
}
